// Correlation engine (system-architecture.md §2 "server/tailor" row) — the
// async pipeline that extracts JD facts (already scored, résumé-independent),
// runs the LLM classifier against the active résumé, deterministically
// verifies the model's cited evidence (correlate-metrics.ts's
// verifyEvidence — fail-safe: an uncited/unverifiable claim is downgraded to
// `gap`, never trusted as-is), and persists a CorrelationReport. Same
// queued-then-async-completes run pattern as startTailor (index.ts),
// stages `extract -> classify -> verify -> done`.
import { z } from "zod";
import { getLlm, type LlmClient } from "@/lib/llm/client";
import { modelFor } from "@/lib/llm/models";
import { renderTemplate } from "@/lib/llm/templates";
import { jobScoresRepo } from "@/server/persistence/repos/jobScores";
import { jobsRepo } from "@/server/persistence/repos/jobs";
import { resumesRepo, type ResumeRow } from "@/server/persistence/repos/resumes";
import {
  correlationReportsRepo, type CorrelationReportRow,
} from "@/server/persistence/repos/correlationReports";
import { create, type RunHandle } from "@/server/runs/registry";
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

export interface CorrelateDeps { llm?: LlmClient; }

export async function correlate(
  userId: string, input: { jobId: string }, deps: CorrelateDeps = {},
): Promise<CorrelationReport> {
  if (!(await jobsRepo.existsById(input.jobId, userId))) throw new UnknownJobError(input.jobId);
  const resumeRow = await resumesRepo.getActive(userId);
  if (!resumeRow) throw new NoActiveResumeError();
  const scoreRow = await jobScoresRepo.getLatestByJobId(input.jobId);
  if (!scoreRow?.jdFacts) throw new NoJdFactsError(input.jobId);

  const inserted = await correlationReportsRepo.insert({
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

  const requirements = buildRequirements(jd);
  handle.emit({ event: "progress", data: { stage: "classify", current: 1, total: 3, label: "Matching against your résumé…" } });

  const llm = deps.llm ?? getLlm();
  const result = await llm.complete({
    task: "correlate",
    messages: renderTemplate("correlate", {
      requirements: JSON.stringify(requirements),
      resume: JSON.stringify(resumeRow.structured),
    }),
    responseSchema: CorrelateResultSchema,
  });

  handle.emit({ event: "progress", data: { stage: "verify", current: 2, total: 3, label: "Verifying evidence…" } });

  const byId = new Map(requirements.map((r) => [r.id, r]));
  const missing = requirements.filter((r) => !result.data.rows.some((o) => o.id === r.id));
  if (missing.length > 0) {
    throw new Error(`correlate: classifier dropped requirement id(s) ${missing.map((m) => m.id).join(",")}`);
  }
  const classified: Omit<CorrelationRow, "atsPresent">[] = result.data.rows.map((o) => {
    const req = byId.get(o.id);
    if (!req) throw new Error(`correlate: classifier returned unknown id ${o.id}`);
    return { requirement: req.text, term: o.term, kind: req.kind, status: o.status,
      evidence: o.evidence, reason: o.reason, note: o.note };
  });
  const verified = verifyEvidence(classified, resumeRow.structured);

  const completed = await correlationReportsRepo.complete(row.id, {
    rows: verified, semantic: semanticSignal(verified), ats: atsSignal(verified),
    model: result.model, costUsd: result.costUsd, completedAt: new Date(),
  });
  if (!completed) throw new Error(`correlation_reports row ${row.id} vanished before completion`);
  handle.emit({ event: "done", data: toCorrelationReport(completed) });
}

async function failRun(id: string, handle: RunHandle, err: unknown): Promise<void> {
  console.error(`correlate run ${id} crashed:`, err);
  const message = err instanceof Error ? err.message : String(err);
  try { await correlationReportsRepo.markFailed(id); }
  catch (e) { console.error(`correlate run ${id}: failed to persist 'failed':`, e); }
  handle.emit({ event: "error", data: { error: { code: "INTERNAL", message } } });
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
