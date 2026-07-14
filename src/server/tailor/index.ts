// F6 — per-job résumé tailoring (system-architecture.md §2 "server/tailor"
// row, §4 "F6 Tailor"). Same run/SSE pattern as B5/B6 search
// (server/runs/registry.ts): `startTailor` returns the queued draft
// immediately and completes the LLM call asynchronously, emitting
// `analyze -> rewrite -> render -> done` progress. LaTeX is DROPPED — the
// model returns a tailored `ResumeStore` JSON + a `diff[]`, never HTML.
import { z } from "zod";
import { getLlm, type LlmClient } from "@/lib/llm/client";
import { modelFor } from "@/lib/llm/models";
import { renderTemplate } from "@/lib/llm/templates";
import { htmlToPdf } from "@/lib/pdf";
import { renderCvHtml } from "@/lib/resume-render";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";
import { jobScoresRepo } from "@/server/persistence/repos/jobScores";
import { jobsRepo } from "@/server/persistence/repos/jobs";
import { resumesRepo, type ResumeRow } from "@/server/persistence/repos/resumes";
import { tailoredResumesRepo, type TailoredResumeRow } from "@/server/persistence/repos/tailoredResumes";
import { create, type RunHandle } from "@/server/runs/registry";
import { ResumeStoreSchema } from "@/server/resume/resume-store";
import { TailoredResume } from "@/types";
import { toTailoredResume } from "./assemble";
import { applyAcceptedDiff, DiffEntrySchema } from "./merge";

export class UnknownJobError extends Error {
  constructor(jobId: string) {
    super(`No job with id "${jobId}".`);
    this.name = "UnknownJobError";
  }
}

export class NoActiveResumeError extends Error {
  constructor(message = "No résumé exists — tailoring requires an active résumé.") {
    super(message);
    this.name = "NoActiveResumeError";
  }
}

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

// The `tailor` template's response_format schema — a tailored ResumeStore +
// the changes list. Escalate (don't invent op values) if this can't express
// what the template actually returns.
//
// task-B8 review pass, Finding 1: a model response with two diff entries
// naming the SAME section is rejected here (fail loud) rather than merged —
// applyAcceptedDiff's `merged[section] = tailored[section]` copies the
// WHOLE tailored section for an accepted index, so two same-section entries
// (accept one, reject the other) would leak the rejected entry's content
// into the merge. config/templates/tailor.md instructs the model to emit
// exactly one entry per section.
export const TailorResultSchema = z
  .object({
    resume: ResumeStoreSchema,
    diff: z.array(DiffEntrySchema),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const entry of value.diff) {
      if (seen.has(entry.section)) {
        ctx.addIssue({
          code: "custom",
          message: `diff[] has more than one entry for section "${entry.section}" — exactly one entry per section is required (config/templates/tailor.md).`,
          path: ["diff"],
        });
      }
      seen.add(entry.section);
    }
  });
export type TailorResult = z.infer<typeof TailorResultSchema>;

export interface StartTailorInput {
  jobId: string;
}

export interface StartTailorDeps {
  llm?: LlmClient;
}

export async function startTailor(input: StartTailorInput, deps: StartTailorDeps = {}): Promise<TailoredResume> {
  if (!(await jobsRepo.existsById(input.jobId))) throw new UnknownJobError(input.jobId);

  const resumeRow = await resumesRepo.getActive();
  if (!resumeRow) throw new NoActiveResumeError();

  const inserted = await tailoredResumesRepo.insert({
    userId: BOOTSTRAP_ADMIN_ID,
    jobId: input.jobId,
    baseResumeId: resumeRow.id,
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
    data: { stage: "analyze", current: 0, total: 3, label: "Analyzing job requirements…" },
  });

  const scoreRow = await jobScoresRepo.getLatestByJobId(row.jobId);
  const jdFactsText = scoreRow?.jdFacts
    ? JSON.stringify(scoreRow.jdFacts)
    : "Not available — this job has not been scored yet.";
  const gapsText = scoreRow?.gaps
    ? JSON.stringify(scoreRow.gaps)
    : "Not available — this job has not been scored yet.";

  handle.emit({
    event: "progress",
    data: { stage: "rewrite", current: 1, total: 3, label: "Rewriting résumé…" },
  });

  const llm = deps.llm ?? getLlm();
  const result = await llm.complete({
    task: "tailor",
    messages: renderTemplate("tailor", {
      resume: JSON.stringify(resumeRow.structured),
      jdFacts: jdFactsText,
      gaps: gapsText,
    }),
    responseSchema: TailorResultSchema,
  });

  handle.emit({
    event: "progress",
    data: { stage: "render", current: 2, total: 3, label: "Preparing the diff for review…" },
  });

  const completedAt = new Date();
  const completed = await tailoredResumesRepo.complete(row.id, {
    structured: result.data.resume,
    diff: result.data.diff,
    model: result.model,
    costUsd: result.costUsd,
    completedAt,
  });
  if (!completed) throw new Error(`tailored_resumes row ${row.id} vanished before completion could be recorded`);

  handle.emit({ event: "done", data: await toTailoredResume(completed) });
}

// task-B8 review pass, Finding 2: `structured` is immutable once completed —
// finalize never overwrites it. It only validates the accepted set against
// this run's diff[] (applyAcceptedDiff throws on a bad index/section) and
// persists the selection; the merged view itself is recomputed fresh from
// (base résumé + structured + acceptedIndices) on every read
// (assemble.ts's toTailoredResume, renderTailorPdf below) — so re-finalize
// with a different accepted set is always correct (api-contract.md §3
// "GET .../pdf renders whatever this route LAST finalized").
export async function finalizeTailor(id: string, acceptedIndices: number[]): Promise<TailoredResume> {
  const row = await tailoredResumesRepo.getById(id);
  if (!row) throw new UnknownTailorIdError(id);
  if (row.status !== "completed" || !row.structured) {
    throw new RunNotReadyError(`Tailor run ${id} is not ready to finalize (status: ${row.status}).`);
  }

  const baseResumeRow = await resumesRepo.getById(row.baseResumeId);
  if (!baseResumeRow) {
    throw new Error(`tailored_resumes ${id}: base résumé ${row.baseResumeId} no longer exists`);
  }

  applyAcceptedDiff(baseResumeRow.structured, row.structured, row.diff, acceptedIndices);

  const updated = await tailoredResumesRepo.finalize(id, { acceptedIndices, finalizedAt: new Date() });
  if (!updated) throw new Error(`tailored_resumes ${id} vanished during finalize`);
  return toTailoredResume(updated);
}

export async function renderTailorPdf(id: string): Promise<Buffer> {
  const row = await tailoredResumesRepo.getById(id);
  if (!row) throw new UnknownTailorIdError(id);
  if (!row.finalizedAt || row.status !== "completed" || !row.structured) {
    throw new RunNotReadyError(`Tailor run ${id} has not been finalized yet.`);
  }
  if (!row.acceptedIndices) {
    throw new Error(`tailored_resumes ${id}: finalizedAt is set but acceptedIndices is null`);
  }

  const baseResumeRow = await resumesRepo.getById(row.baseResumeId);
  if (!baseResumeRow) {
    throw new Error(`tailored_resumes ${id}: base résumé ${row.baseResumeId} no longer exists`);
  }

  const merged = applyAcceptedDiff(baseResumeRow.structured, row.structured, row.diff, row.acceptedIndices);
  const html = renderCvHtml(merged);
  return htmlToPdf(html);
}
