// Correlation engine (system-architecture.md §2 "server/tailor" row) — the
// async pipeline that extracts JD facts (already scored, résumé-independent),
// runs the LLM classifier against the active résumé, deterministically
// verifies the model's cited evidence (correlate-metrics.ts's
// verifyEvidence — fail-safe: an uncited/unverifiable claim is downgraded to
// `gap`, never trusted as-is), and persists a CorrelationReport. Same
// queued-then-async-completes run pattern as startTailor (index.ts),
// stages `extract -> classify -> verify -> done`.
import { z, ZodError } from "zod";
import { getLlm, type LlmClient } from "@/lib/llm/client";
import { modelFor } from "@/lib/llm/models";
import { renderTemplate } from "@/lib/llm/templates";
import { jobScoresRepo } from "@/server/persistence/repos/jobScores";
import { jobsRepo } from "@/server/persistence/repos/jobs";
import { resumesRepo, type ResumeRow } from "@/server/persistence/repos/resumes";
import {
  correlationReportsRepo, type CorrelationReportRow,
} from "@/server/persistence/repos/correlationReports";
import { create, release, type RunHandle } from "@/server/runs/registry";
import { assertAndDebit } from "@/server/credits";
import type { ResumeStore } from "@/server/resume/resume-store";
import type { JdFacts } from "@/server/score/jdFacts";
import { CorrelationReport, type CorrelationRow } from "@/types";
import { atsSignal, semanticSignal, verifyEvidence } from "./correlate-metrics";
import { NoActiveResumeError, UnknownJobError } from "./errors";

export class NoJdFactsError extends Error {
  constructor(jobId: string) {
    super(`Job "${jobId}" has no extracted JD facts — score this job first.`);
    this.name = "NoJdFactsError";
  }
}

export function buildRequirements(jd: JdFacts) {
  const rows: { id: number; kind: "must" | "nice" | "responsibility"; text: string }[] = [];
  let id = 0;
  for (const text of jd.mustHaves) rows.push({ id: id++, kind: "must", text });
  for (const text of jd.niceToHaves) rows.push({ id: id++, kind: "nice", text });
  for (const text of jd.responsibilities) rows.push({ id: id++, kind: "responsibility", text });
  return rows;
}

export const CorrelateResultSchema = z.object({
  rows: z.array(z.object({
    id: z.number().int(),
    term: z.string(),
    status: z.enum(["met", "buried", "gap"]),
    evidence: z.string().nullable(),
    reason: z.string(),
    note: z.string().nullable(),
  })),
});

// classifyRequirements's bijection guards (every requirement id present
// exactly once, no unknown ids) — a model emission defect distinct from a
// ZodError, but equally worth one corrective re-ask. Kept local since it is
// only ever thrown/caught inside classifyRequirements's own retry loop.
class CorrelateEmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorrelateEmissionError";
  }
}

function isRetryableClassifyError(err: unknown): boolean {
  return err instanceof ZodError || err instanceof CorrelateEmissionError;
}

// Shared classify+verify core (DB-free): id-joins the classifier's response
// back onto `requirements` (bijection guard — every requirement id must
// appear exactly once, never dropped/duplicated/unknown), then runs the
// deterministic verifyEvidence pass. Used by both `classifyAndVerify` (the
// DB-free helper the live eval calls directly against a fixture) and
// `runCorrelateJob` (which additionally needs `model`/`costUsd` for
// persistence) — kept as one implementation so the two never drift.
//
// Bounded corrective retry (mirrors emitTailorRewrite, index.ts): the
// classifier occasionally emits a top-level ARRAY instead of the object
// (ZodError from llm.complete) or drops/duplicates/invents a requirement id
// (the bijection guards below, wrapped as CorrelateEmissionError so the
// catch can tell them apart from an arbitrary Error). One re-ask, then fail
// loud.
async function classifyRequirements(
  jd: JdFacts, store: ResumeStore, llm: LlmClient,
): Promise<{ rows: CorrelationRow[]; model: string; costUsd: number }> {
  const requirements = buildRequirements(jd);
  const byId = new Map(requirements.map((r) => [r.id, r]));
  const baseMessages = renderTemplate("correlate", {
    requirements: JSON.stringify(requirements),
    resume: JSON.stringify(store),
  });

  let attemptMessages = baseMessages;
  let totalCostUsd = 0;

  for (let attempt = 1; ; attempt++) {
    let result: { data: z.infer<typeof CorrelateResultSchema>; model: string; costUsd: number } | undefined;
    try {
      result = await llm.complete({
        task: "correlate",
        messages: attemptMessages,
        responseSchema: CorrelateResultSchema,
      });
      totalCostUsd += result.costUsd;
      // Rebind to a `const` (narrowed non-undefined) so the closures below
      // don't reference the outer `let result`, which TS's control-flow
      // analysis can't narrow across a function boundary.
      const { data, model } = result;

      const missing = requirements.filter((r) => !data.rows.some((o) => o.id === r.id));
      if (missing.length > 0) {
        throw new CorrelateEmissionError(`correlate: classifier dropped requirement id(s) ${missing.map((m) => m.id).join(",")}`);
      }
      if (data.rows.length !== requirements.length) {
        throw new CorrelateEmissionError(`correlate: classifier returned ${data.rows.length} rows for ${requirements.length} requirements (duplicate or extra ids)`);
      }
      const classified: Omit<CorrelationRow, "atsPresent">[] = data.rows.map((o) => {
        const req = byId.get(o.id);
        if (!req) throw new CorrelateEmissionError(`correlate: classifier returned unknown id ${o.id}`);
        return { requirement: req.text, term: o.term, kind: req.kind, status: o.status,
          evidence: o.evidence, reason: o.reason, note: o.note };
      });
      return { rows: verifyEvidence(classified, store), model, costUsd: totalCostUsd };
    } catch (err) {
      if (attempt >= 2 || !isRetryableClassifyError(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`correlate classify attempt 1 rejected: ${message} — retrying once with corrective feedback`);
      attemptMessages = [
        ...baseMessages,
        // If llm.complete itself threw (no `result`), there is no assistant
        // turn to echo back.
        ...(result !== undefined ? [{ role: "assistant" as const, content: JSON.stringify(result.data) }] : []),
        {
          role: "user",
          content: `That response was rejected: ${message}. Re-emit the ENTIRE corrected JSON object of shape {"rows": [...]} — one row per requirement id, every id exactly once, all fields present (evidence and note may be null).`,
        },
      ];
    }
  }
}

// DB-free classify+verify path — no persistence, no run handle. Exposed so
// the live eval harness (eval.live.test.ts) can drive the real classifier
// against a golden fixture's ResumeStore/JdFacts directly.
export async function classifyAndVerify(
  jd: JdFacts, store: ResumeStore, llm: LlmClient,
): Promise<CorrelationRow[]> {
  return (await classifyRequirements(jd, store, llm)).rows;
}

export interface CorrelateDeps { llm?: LlmClient; }

export async function correlate(
  userId: string, input: { jobId: string }, deps: CorrelateDeps = {},
  opts: { prepaid?: boolean } = {},
): Promise<CorrelationReport> {
  if (!(await jobsRepo.existsById(input.jobId, userId))) throw new UnknownJobError(input.jobId);
  const resumeRow = await resumesRepo.getActive(userId);
  if (!resumeRow) throw new NoActiveResumeError();
  const scoreRow = await jobScoresRepo.getLatestByJobId(input.jobId);
  if (!scoreRow?.jdFacts) throw new NoJdFactsError(input.jobId);

  const reportId = crypto.randomUUID();
  // The tailor-without-report flow (startTailor, index.ts) already debited 8
  // at ITS admission and calls this from the background job with prepaid — a
  // debit here would double-charge, and a 402 here could never reach the
  // user (the background job can only fail the run, not respond to a request).
  if (!opts.prepaid) await assertAndDebit(userId, "tailor", { refId: reportId });

  const inserted = await correlationReportsRepo.insert({
    id: reportId,
    userId, jobId: input.jobId, resumeId: resumeRow.id, rows: [],
    status: "queued", model: modelFor("correlate").model,
  });
  const handle = create("correlate", inserted.id, userId);
  void runCorrelateJob(inserted, resumeRow, scoreRow.jdFacts as JdFacts, handle, deps)
    .catch((err) => failRun(inserted.id, handle, err));
  return toCorrelationReport(inserted);
}

async function runCorrelateJob(
  row: CorrelationReportRow, resumeRow: ResumeRow, jd: JdFacts,
  handle: RunHandle, deps: CorrelateDeps,
): Promise<void> {
  await correlationReportsRepo.updateStatus(row.id, "running");
  handle.emit({ event: "progress", data: { stage: "extract", current: 0, total: 3, label: "Reading requirements…" } });
  handle.emit({ event: "progress", data: { stage: "classify", current: 1, total: 3, label: "Matching against your résumé…" } });

  const llm = deps.llm ?? getLlm();
  const { rows: verified, model, costUsd } = await classifyRequirements(jd, resumeRow.structured, llm);

  handle.emit({ event: "progress", data: { stage: "verify", current: 2, total: 3, label: "Verifying evidence…" } });

  const completed = await correlationReportsRepo.complete(row.id, {
    rows: verified, semantic: semanticSignal(verified), ats: atsSignal(verified),
    model, costUsd, completedAt: new Date(),
  });
  if (!completed) throw new Error(`correlation_reports row ${row.id} vanished before completion`);
  handle.emit({ event: "done", data: toCorrelationReport(completed) });
  release(row.id);
}

async function failRun(id: string, handle: RunHandle, err: unknown): Promise<void> {
  console.error(`correlate run ${id} crashed:`, err);
  const message = err instanceof Error ? err.message : String(err);
  try { await correlationReportsRepo.markFailed(id); }
  catch (e) { console.error(`correlate run ${id}: failed to persist 'failed':`, e); }
  handle.emit({ event: "error", data: { error: { code: "INTERNAL", message } } });
  release(id);
}

export function toCorrelationReport(row: CorrelationReportRow): CorrelationReport {
  return CorrelationReport.parse({
    id: row.id, jobId: row.jobId, resumeId: row.resumeId, status: row.status, progress: null,
    rows: row.rows, semantic: row.semantic ?? { met: 0, buried: 0, gap: 0, total: 0 },
    ats: row.ats ?? { present: 0, total: 0, missing: [] },
    model: row.model, costUsd: row.costUsd,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  });
}
