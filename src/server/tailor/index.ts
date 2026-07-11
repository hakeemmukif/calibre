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
import { jobScoresRepo } from "@/server/persistence/repos/jobScores";
import { jobsRepo } from "@/server/persistence/repos/jobs";
import { resumesRepo, type ResumeRow } from "@/server/persistence/repos/resumes";
import { tailoredResumesRepo, type TailoredResumeRow } from "@/server/persistence/repos/tailoredResumes";
import { create, type RunHandle } from "@/server/runs/registry";
import type { ResumeStore } from "@/server/resume/resume-store";
import { ResumeStoreSchema } from "@/server/resume/resume-store";
import { TailoredResume } from "@/types";
import { toTailoredResume } from "./assemble";

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

export class InvalidDiffIndexError extends Error {
  constructor(index: number, diffLength: number) {
    super(`acceptedIndices contains ${index}, out of range for a diff[] of length ${diffLength}.`);
    this.name = "InvalidDiffIndexError";
  }
}

export class UnknownDiffSectionError extends Error {
  constructor(section: string) {
    super(`diff entry names section "${section}", which is not a résumé top-level field the merge understands.`);
    this.name = "UnknownDiffSectionError";
  }
}

// Frozen TailoredResume.diff shape (src/types), reused verbatim so this
// schema can never drift from the wire contract.
const DiffEntrySchema = TailoredResume.shape.diff.element;
export type DiffEntry = z.infer<typeof DiffEntrySchema>;

// The `tailor` template's response_format schema — a tailored ResumeStore +
// the changes list. Escalate (don't invent op values) if this can't express
// what the template actually returns.
export const TailorResultSchema = z.object({
  resume: ResumeStoreSchema,
  diff: z.array(DiffEntrySchema),
});
export type TailorResult = z.infer<typeof TailorResultSchema>;

// Only top-level ResumeStore fields the accepted-only merge (finalizeTailor)
// knows how to apply per diff entry — a `section` outside this set fails
// loud rather than silently no-op'ing (constraints: fail loud, no fallback).
const MERGEABLE_SECTIONS = new Set<keyof ResumeStore>([
  "name",
  "contact",
  "summary",
  "experience",
  "education",
  "skills",
  "extras",
]);

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
  handle.emit({ event: "error", data: { error: { code: "CONFLICT", message } } });
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

  handle.emit({ event: "done", data: toTailoredResume(completed) });
}

// Accepted-only merge (task-B8-brief.md §"Behaviour"): start from the base
// (untailored) résumé, then for each accepted diff index overlay that whole
// top-level section from the tailored store. `before`/`after` on a diff
// entry are review-UI text, not the merge mechanism — the merge always takes
// the tailored store's full value for an accepted section, the base store's
// for everything else (including rejected/unmentioned sections).
function applyAcceptedDiff(
  base: ResumeStore,
  tailored: ResumeStore,
  diff: DiffEntry[],
  acceptedIndices: number[],
): ResumeStore {
  const merged = structuredClone(base);
  for (const index of acceptedIndices) {
    const entry = diff[index];
    if (!entry) throw new InvalidDiffIndexError(index, diff.length);
    if (!MERGEABLE_SECTIONS.has(entry.section as keyof ResumeStore)) {
      throw new UnknownDiffSectionError(entry.section);
    }
    const key = entry.section as keyof ResumeStore;
    (merged as Record<string, unknown>)[key] = tailored[key];
  }
  return merged;
}

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

  const merged = applyAcceptedDiff(baseResumeRow.structured, row.structured, row.diff, acceptedIndices);

  const updated = await tailoredResumesRepo.finalize(id, { structured: merged, finalizedAt: new Date() });
  if (!updated) throw new Error(`tailored_resumes ${id} vanished during finalize`);
  return toTailoredResume(updated);
}

export async function renderTailorPdf(id: string): Promise<Buffer> {
  const row = await tailoredResumesRepo.getById(id);
  if (!row) throw new UnknownTailorIdError(id);
  if (!row.finalizedAt || row.status !== "completed" || !row.structured) {
    throw new RunNotReadyError(`Tailor run ${id} has not been finalized yet.`);
  }

  const html = renderCvHtml(row.structured);
  return htmlToPdf(html);
}
