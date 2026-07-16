// F6 — per-job résumé tailoring (system-architecture.md §2 "server/tailor"
// row, §4 "F6 Tailor"). Same run/SSE pattern as B5/B6 search
// (server/runs/registry.ts): `startTailor` returns the queued draft
// immediately and completes the LLM call asynchronously, emitting
// `correlate -> rewrite -> render -> done` progress. The rewrite is now
// report-driven (tailor-correlation-engine design §6): it is constrained to
// a CorrelationReport (`correlate.ts`) rather than the raw jdFacts/gaps of
// the latest job_scores row — this also fixes the résumé-staleness bug
// (design §7), since the report was computed against the SAME résumé this
// run tailors. The model returns EDITS ONLY (`diff[]`, addressable at
// bullet granularity); the tailored `structured` is always DERIVED
// server-side via `applyEdits`, never emitted by the model directly.
import { z, ZodError } from "zod";
import { getLlm, type LlmClient, type LlmMessage } from "@/lib/llm/client";
import { modelFor } from "@/lib/llm/models";
import { renderTemplate } from "@/lib/llm/templates";
import { htmlToPdf } from "@/lib/pdf";
import { renderCvHtml } from "@/lib/resume-render";
import { jobsRepo } from "@/server/persistence/repos/jobs";
import { resumesRepo, type ResumeRow } from "@/server/persistence/repos/resumes";
import { tailoredResumesRepo, type TailoredResumeRow } from "@/server/persistence/repos/tailoredResumes";
import { correlationReportsRepo, type CorrelationReportRow } from "@/server/persistence/repos/correlationReports";
import type { ResumeStore } from "@/server/resume/resume-store";
import { create, release, type RunHandle } from "@/server/runs/registry";
import { TailoredResume } from "@/types";
import { toTailoredResume } from "./assemble";
import { correlate, type CorrelateDeps } from "./correlate";
import { atsPresentCount, fabricationViolations } from "./correlate-metrics";
import { NoActiveResumeError, TailorFabricationError, UnknownJobError, UnknownReportError } from "./errors";
import { applyAcceptedDiff, applyEdits, DiffEntrySchema, InvalidDiffIndexError, MalformedDiffEditError, UnknownDiffSectionError } from "./merge";

export { NoActiveResumeError, TailorFabricationError, UnknownJobError, UnknownReportError } from "./errors";

export class UnknownTailorIdError extends Error {
  constructor(id: string) {
    super(`No tailored_resumes row with id "${id}".`);
    this.name = "UnknownTailorIdError";
  }
}

// 409 RUN_NOT_READY (api-contract.md §3): finalize before completion, or PDF
// before finalize.
export class RunNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunNotReadyError";
  }
}

// Re-exported so route handlers (e.g. app/api/tailor/[id]/finalize/route.ts)
// can keep importing these from "@/server/tailor" (this module's barrel).
export { InvalidDiffIndexError, UnknownDiffSectionError } from "./merge";

// The `tailor` template's response_format schema — EDITS ONLY (design §6):
// the model never emits a full tailored ResumeStore; the tailored
// `structured` is always derived server-side by applying `diff[]` to the
// base résumé (`applyEdits`), so the model cannot rewrite un-targeted
// content and every change is an addressable, reviewable edit. Multiple
// edits per section are valid — each targets a distinct `target.index`/
// `target.bulletIndex`, so the one-entry-per-section constraint (a
// `merge.ts` same-section merge hazard that no longer exists post-Task-9)
// is retired.
// `before` is optional on the wire-level DiffEntrySchema (shared with
// `remove`, which carries no `before`/`after`), but for a MODEL-EMITTED
// `modify` it is the WYSIWYG anchor a reviewer's accept/reject decision is
// based on — an omitted `before` would bypass `merge.ts`'s before-mismatch
// guard entirely (undefined skips the check) and risk silently rewriting
// the wrong bullet, which gpt-oss-120b's known habit of omitting optional
// json_schema fields makes a real hazard, not a hypothetical one. So this
// schema (used only to validate the LLM's own response, not the wire
// contract) fails loud instead: every `modify` entry must carry BOTH a
// non-empty `before` and `after`.
export const TailorResultSchema = z.object({
  diff: z.array(DiffEntrySchema),
}).superRefine((val, ctx) => {
  val.diff.forEach((entry, i) => {
    if (entry.op !== "modify") return;
    if (!entry.before) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["diff", i, "before"], message: `diff[${i}]: a "modify" edit must include a non-empty "before" (the WYSIWYG anchor) — omitting it risks silently rewriting the wrong bullet.` });
    }
    if (!entry.after) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["diff", i, "after"], message: `diff[${i}]: a "modify" edit must include a non-empty "after".` });
    }
  });
});
export type TailorResult = z.infer<typeof TailorResultSchema>;

// Emit-side twin of TailorResultSchema. gpt-oss-120b drops any field not in
// the derived json_schema's `required` list (see the correlate classify
// schema for the same workaround), so the LLM-facing shape makes every field
// required and models absence as null. Parsed output is normalised back onto
// the wire shape and re-validated by TailorResultSchema — the modify-anchor
// superRefine stays the real enforcement point.
const TailorEmitEntry = z.object({
  section: z.string(),
  op: z.enum(["add", "remove", "modify"]),
  before: z.string().nullable(),
  after: z.string().nullable(),
  reason: z.string(),
  requirement: z.string(),
  target: z.object({ index: z.number().int().nullable(), bulletIndex: z.number().int().nullable() }),
});
export const TailorEmitSchema = z.object({ diff: z.array(TailorEmitEntry) });

export interface StartTailorInput {
  jobId: string;
  reportId?: string;
}

export interface StartTailorDeps {
  llm?: LlmClient;
}

export async function startTailor(
  userId: string,
  input: StartTailorInput,
  deps: StartTailorDeps = {},
): Promise<TailoredResume> {
  if (!(await jobsRepo.existsById(input.jobId, userId))) throw new UnknownJobError(input.jobId);

  const resumeRow = await resumesRepo.getActive(userId);
  if (!resumeRow) throw new NoActiveResumeError();

  // Existence/ownership AND job/résumé identity of a caller-supplied
  // reportId are checked SYNCHRONOUSLY here, before the tailored_resumes row
  // is even inserted — an unknown, foreign-owned, or wrong-job/résumé
  // reportId is a client request error (404/400), not something that should
  // silently insert a doomed row referencing another job's report (which
  // would FK-block deleting that other job even after it's tailored) and
  // fail async. Whether the report has reached "completed" status is a
  // different, run-dependent question that resolveReport still answers
  // asynchronously (it may still be running at request time), so that check
  // stays there. resolveReport's own assertReportMatchesRun call is now
  // redundant for this supplied-reportId path (already checked here) but is
  // kept — it is the only identity check for the no-reportId path, where
  // `correlate` resolves the report after this point.
  if (input.reportId) {
    const report = await correlationReportsRepo.getById(input.reportId, userId);
    if (!report) throw new UnknownReportError(input.reportId);
    assertReportMatchesRun(report, { jobId: input.jobId, baseResumeId: resumeRow.id });
  }

  const inserted = await tailoredResumesRepo.insert({
    userId,
    jobId: input.jobId,
    baseResumeId: resumeRow.id,
    reportId: input.reportId ?? null,
    diff: [],
    status: "queued",
    model: modelFor("tailor").model,
  });

  const handle = create("tailor", inserted.id);

  void runTailorJob(inserted, resumeRow, handle, deps).catch((err) => {
    void failRun(inserted.id, handle, err);
  });

  return toTailoredResume(inserted);
}

async function failRun(id: string, handle: RunHandle, err: unknown): Promise<void> {
  console.error(`tailor run ${id} crashed unexpectedly:`, err);
  const message = err instanceof Error ? err.message : String(err);
  try {
    await tailoredResumesRepo.markFailed(id);
  } catch (persistErr) {
    console.error(`tailor run ${id}: failed to persist 'failed' status after crash:`, persistErr);
  }
  handle.emit({ event: "error", data: { error: { code: "INTERNAL", message } } });
  release(id);
}

// A poll loop is a new pattern for this feature (correlate's own async job
// engine has no analogue elsewhere in server/*) because tailor now needs to
// wait on a DIFFERENT job's (correlate's) terminal state rather than just
// its own — mirrors the wait-for-terminal-status idiom `correlate.test.ts`
// uses from outside the process, but from inside runTailorJob instead.
// Bounded (fail loud, not an infinite hang) at roughly the LLM SDK's own
// per-call ceiling (src/lib/llm/client.ts's OpenAI default timeout is 10
// minutes) — a shorter cap could abandon a correlate run that was always
// going to finish.
const CORRELATE_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const CORRELATE_POLL_INTERVAL_MS = 250;

async function pollCorrelationUntilTerminal(id: string, userId: string): Promise<CorrelationReportRow> {
  const deadline = Date.now() + CORRELATE_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const report = await correlationReportsRepo.getById(id, userId);
    if (report?.status === "completed") return report;
    if (report?.status === "failed") {
      throw new Error(`correlation report ${id} failed — cannot tailor from a failed report.`);
    }
    await new Promise((resolve) => setTimeout(resolve, CORRELATE_POLL_INTERVAL_MS));
  }
  throw new Error(`correlation report ${id} did not complete within ${CORRELATE_POLL_TIMEOUT_MS}ms.`);
}

// Report resolution (design §6 "resolve the report"): a caller-supplied
// `reportId` must already be a COMPLETED report this user owns — rewriting
// off a queued/running/failed report would constrain the model with partial
// or absent rows. With no `reportId`, tailor computes its own correlation
// fresh against the SAME résumé it is about to rewrite (design §7 — this is
// what kills the staleness bug: no reuse of another résumé's stale
// artifact) and waits for it to land before continuing.
// A report is only a valid rewrite constraint for THIS run if it was
// computed against the SAME job and the SAME base résumé — a report for a
// different job is simply wrong, and a report for a different/older résumé
// reintroduces the exact staleness bug design §7 exists to kill (the report
// would cite evidence/gaps against résumé content this run isn't rewriting).
function assertReportMatchesRun(report: CorrelationReportRow, run: { jobId: string; baseResumeId: string }): void {
  if (report.jobId !== run.jobId) {
    throw new Error(
      `correlation report ${report.id} was computed for job ${report.jobId}, not this tailor run's job ${run.jobId}.`,
    );
  }
  if (report.resumeId !== run.baseResumeId) {
    throw new Error(
      `correlation report ${report.id} was computed against résumé ${report.resumeId}, not this tailor run's base résumé ${run.baseResumeId} — refusing to rewrite from a stale report.`,
    );
  }
}

async function resolveReport(row: TailoredResumeRow, deps: CorrelateDeps): Promise<CorrelationReportRow> {
  if (row.reportId) {
    const report = await correlationReportsRepo.getById(row.reportId, row.userId);
    if (!report) throw new UnknownReportError(row.reportId);
    if (report.status !== "completed") {
      throw new Error(
        `correlation report ${row.reportId} is not completed (status: ${report.status}) — cannot tailor from an incomplete report.`,
      );
    }
    assertReportMatchesRun(report, row);
    return report;
  }

  const started = await correlate(row.userId, { jobId: row.jobId }, deps);
  const report = await pollCorrelationUntilTerminal(started.id, row.userId);
  assertReportMatchesRun(report, row);
  return report;
}

// Emission errors this function's corrective retry treats as "the model's
// fault, worth one re-ask": a structurally invalid diff (e.g. a list-section
// modify with a null target.bulletIndex, the intermittent ~1-in-4 failure
// this retry exists for), a raw emission that fails TailorEmitSchema itself
// (llm.complete's own responseSchema.parse — a strict:true violation or a
// stray malformed field), and fabrication (TailorFabricationError — the
// model writing a JD numeral like "5" from "At least 5 years..." into an
// edit instead of the résumé's own "seven years"). All three are model
// emission noise a re-ask can plausibly fix. The requirement-allowlist guard
// is NOT retried here — that's an honesty guard runTailorJob applies AFTER
// this function returns, checking against the report rather than the
// résumé, and not the kind of defect a corrective re-ask targets.
function isRetryableEmitError(err: unknown): boolean {
  return (
    err instanceof ZodError ||
    err instanceof MalformedDiffEditError ||
    err instanceof InvalidDiffIndexError ||
    err instanceof UnknownDiffSectionError ||
    err instanceof TailorFabricationError
  );
}

// Shared by runTailorJob and the live eval harness (eval.live.test.ts) so
// both drive the SAME emit-side schema (TailorEmitSchema) and the SAME
// bounded corrective retry — the eval harness used to hand-roll its own
// llm.complete call against TailorResultSchema (the WIRE schema), which
// reproduced the exact emit-omission bug TailorEmitSchema exists to fix.
export async function emitTailorRewrite(
  llm: LlmClient,
  input: { resume: ResumeStore; candidates: unknown; gaps: string[] },
): Promise<{ diff: TailorResult["diff"]; model: string; costUsd: number }> {
  const messages: LlmMessage[] = renderTemplate("tailor", {
    resume: JSON.stringify(input.resume),
    report: JSON.stringify({ candidates: input.candidates, gaps: input.gaps }),
  });

  let attemptMessages = messages;
  let totalCostUsd = 0;

  for (let attempt = 1; ; attempt++) {
    let result: { data: z.infer<typeof TailorEmitSchema>; model: string; costUsd: number } | undefined;
    try {
      // llm.complete's own responseSchema.parse (client.ts) is now INSIDE
      // this try — a raw emission that fails TailorEmitSchema (a
      // strict:true violation, or the intermittent client-side ZodError this
      // widening exists for) is retryable too, not just the deterministic
      // checks below.
      result = await llm.complete({
        task: "tailor",
        messages: attemptMessages,
        responseSchema: TailorEmitSchema,
      });
      totalCostUsd += result.costUsd;

      // Normalise the emit shape's null-modelled absence back onto the wire
      // shape (before/after optional) and re-validate — TailorResultSchema's
      // superRefine (a non-empty before/after on every `modify`) stays the
      // real enforcement point.
      const normalised = result.data.diff.map(({ before, after, ...rest }) => ({
        ...rest,
        ...(before !== null ? { before } : {}),
        ...(after !== null ? { after } : {}),
      }));
      const { diff } = TailorResultSchema.parse({ diff: normalised });

      // Deterministic pre-validation: a dry-run of the merge this diff will
      // eventually drive (applyEdits structuredClones the base internally),
      // discarded here — this is what catches a list-section modify/remove
      // with a null target.bulletIndex, which TailorResultSchema's own
      // nullable target shape does not reject on its own.
      applyEdits(input.resume, diff);

      // Fabrication pre-check, moved inside the retry loop: a JD numeral
      // (e.g. "5" from "At least 5 years...") bleeding into `after` instead
      // of the résumé's own phrasing ("seven years") is model emission
      // noise, not a caller bug — worth one corrective re-ask before failing
      // the run outright. runTailorJob's post-return fabrication check stays
      // as defense in depth.
      const fabrications = fabricationViolations(diff, input.resume);
      if (fabrications.length > 0) {
        throw new TailorFabricationError(`tailor: fabrication guard rejected the rewrite — ${fabrications.join("; ")}`);
      }

      return { diff, model: result.model, costUsd: totalCostUsd };
    } catch (err) {
      if (attempt >= 2 || !isRetryableEmitError(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`tailor rewrite attempt 1 rejected: ${message} — retrying once with corrective feedback`);
      attemptMessages = [
        ...messages,
        // If llm.complete itself threw (no `result`), there is no assistant
        // turn to echo back.
        ...(result !== undefined ? [{ role: "assistant" as const, content: JSON.stringify(result.data) }] : []),
        {
          role: "user",
          content: `That response was rejected by a deterministic validator: ${message}. Re-emit the ENTIRE corrected {"diff": [...]} JSON. Every modify/remove on a list section (experience, projects, skills) MUST carry a non-null integer target.index AND target.bulletIndex; scalar sections (summary, headline) use null for both; every modify MUST carry non-empty before AND after; never introduce a digit or numeral into "after" that isn't already present in the résumé — including a number copied from the requirement text — keep the résumé's own quantities and phrasing.`,
        },
      ];
    }
  }
}

async function runTailorJob(
  row: TailoredResumeRow,
  resumeRow: ResumeRow,
  handle: RunHandle,
  deps: StartTailorDeps,
): Promise<void> {
  await tailoredResumesRepo.updateStatus(row.id, "running");

  handle.emit({
    event: "progress",
    data: { stage: "correlate", current: 0, total: 3, label: "Correlating résumé to job requirements…" },
  });

  const report = await resolveReport(row, deps);

  handle.emit({
    event: "progress",
    data: { stage: "rewrite", current: 1, total: 3, label: "Rewriting résumé…" },
  });

  // Candidates = the report's rewrite targets (design §6: only `buried`/`met`
  // rows are candidates); `gap` rows are surfaced separately as an explicit
  // do-not-fabricate list — the template instructs the model never to write
  // an edit for one, and the guard below fails loud if it does anyway.
  const candidates = report.rows
    .filter((r) => r.status !== "gap")
    .map((r) => ({ requirement: r.requirement, term: r.term, status: r.status, evidence: r.evidence, reason: r.reason }));
  const gaps = report.rows.filter((r) => r.status === "gap").map((r) => r.requirement);

  const llm = deps.llm ?? getLlm();
  const { diff, model, costUsd } = await emitTailorRewrite(llm, { resume: resumeRow.structured, candidates, gaps });

  // Fabrication guard (design §6, deterministic, fail-loud): an edit's
  // `after` may not introduce a number/metric absent from the base résumé.
  const fabrications = fabricationViolations(diff, resumeRow.structured);
  if (fabrications.length > 0) {
    throw new Error(`tailor: fabrication guard rejected the rewrite — ${fabrications.join("; ")}`);
  }

  // Requirement allowlist guard (design §6 "rewrite CONSTRAINED TO the
  // report"): every edit's `requirement` must name a `met`/`buried` row from
  // THIS report — an exact-string blocklist against `gap` rows alone would
  // let a paraphrased gap or an entirely invented requirement through (and,
  // if its `after` has no digits, past the fabrication guard above too).
  // The allowlist subsumes the old gap check (gap rows are never candidates)
  // and closes that hole in one guard.
  const candidateRequirements = new Set(
    report.rows.filter((r) => r.status === "met" || r.status === "buried").map((r) => r.requirement),
  );
  const invalidEdits = diff.filter((e) => !candidateRequirements.has(e.requirement));
  if (invalidEdits.length > 0) {
    throw new Error(
      `tailor: rewrite wrote an edit for requirement(s) not present as a met/buried row in the report — ${invalidEdits.map((e) => `"${e.requirement}"`).join(", ")}. The rewrite must stay constrained to the report.`,
    );
  }

  handle.emit({
    event: "progress",
    data: { stage: "render", current: 2, total: 3, label: "Preparing the diff for review…" },
  });

  const completedAt = new Date();
  const completed = await tailoredResumesRepo.complete(row.id, {
    structured: applyEdits(resumeRow.structured, diff),
    diff,
    model,
    costUsd,
    completedAt,
    reportId: report.id,
  });
  if (!completed) throw new Error(`tailored_resumes row ${row.id} vanished before completion could be recorded`);

  handle.emit({ event: "done", data: await toTailoredResume(completed) });
  release(row.id);
}

// task-B8 review pass, Finding 2: `structured` is immutable once completed —
// finalize never overwrites it. It only validates the accepted set against
// this run's diff[] (applyAcceptedDiff throws on a bad index/section) and
// persists the selection; the merged view itself is recomputed fresh from
// (base résumé + structured + acceptedIndices) on every read
// (assemble.ts's toTailoredResume, renderTailorPdf below) — so re-finalize
// with a different accepted set is always correct (api-contract.md §3
// "GET .../pdf renders whatever this route LAST finalized").
export async function finalizeTailor(id: string, userId: string, acceptedIndices: number[]): Promise<TailoredResume> {
  const row = await tailoredResumesRepo.getById(id, userId);
  if (!row) throw new UnknownTailorIdError(id);
  if (row.status !== "completed" || !row.structured) {
    throw new RunNotReadyError(`Tailor run ${id} is not ready to finalize (status: ${row.status}).`);
  }

  // row.userId is the tailored_resumes row's real owner (a DB fact, not a
  // scaffold) — the base résumé it points to was inserted for that same user.
  const baseResumeRow = await resumesRepo.getById(row.baseResumeId, row.userId);
  if (!baseResumeRow) {
    throw new Error(`tailored_resumes ${id}: base résumé ${row.baseResumeId} no longer exists`);
  }

  const merged = applyAcceptedDiff(baseResumeRow.structured, row.diff, acceptedIndices);

  // Deterministic ATS before→after delta (tailor-correlation-engine design):
  // `before`/`total` are frozen at the moment the linked report finished
  // (report.ats was computed against the SAME base résumé this run
  // tailors — design §7), `after` is recomputed fresh against the
  // accepted-only merge on every finalize, so re-finalizing with a
  // different accepted set always reflects that set's own ATS delta.
  let atsDelta: { before: number; after: number; total: number } | null = null;
  if (row.reportId) {
    const reportRow = await correlationReportsRepo.getById(row.reportId, userId);
    if (!reportRow) throw new Error(`tailored_resumes ${id}: report ${row.reportId} no longer exists`);
    if (!reportRow.ats) {
      throw new Error(`tailored_resumes ${id}: report ${row.reportId} has no ats signal (status: ${reportRow.status})`);
    }
    const terms = reportRow.rows.map((r) => r.term);
    atsDelta = { before: reportRow.ats.present, after: atsPresentCount(terms, merged), total: reportRow.ats.total };
  }

  const updated = await tailoredResumesRepo.finalize(id, { acceptedIndices, finalizedAt: new Date(), atsDelta });
  if (!updated) throw new Error(`tailored_resumes ${id} vanished during finalize`);
  return toTailoredResume(updated);
}

export async function renderTailorPdf(id: string, userId: string): Promise<Buffer> {
  const row = await tailoredResumesRepo.getById(id, userId);
  if (!row) throw new UnknownTailorIdError(id);
  if (!row.finalizedAt || row.status !== "completed" || !row.structured) {
    throw new RunNotReadyError(`Tailor run ${id} has not been finalized yet.`);
  }
  if (!row.acceptedIndices) {
    throw new Error(`tailored_resumes ${id}: finalizedAt is set but acceptedIndices is null`);
  }

  const baseResumeRow = await resumesRepo.getById(row.baseResumeId, row.userId);
  if (!baseResumeRow) {
    throw new Error(`tailored_resumes ${id}: base résumé ${row.baseResumeId} no longer exists`);
  }

  const merged = applyAcceptedDiff(baseResumeRow.structured, row.diff, row.acceptedIndices);
  const html = renderCvHtml(merged);
  return htmlToPdf(html);
}
