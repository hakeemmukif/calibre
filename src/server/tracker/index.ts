// F5 — the lifelong tracker (system-architecture.md §2 "server/tracker" row,
// §4 "F5 Mark applied"). No LLM. `features/applied/status-map.ts` owns all
// status folding; this module only calls it — never re-derives labels/tones
// itself (task-B9-brief.md "status folding ONLY in status-map").
import { applicationsRepo, ApplicationConflictError, type AppJoinJobScore } from "@/server/persistence/repos/applications";
import { jobsRepo } from "@/server/persistence/repos/jobs";
import { resumesRepo } from "@/server/persistence/repos/resumes";
import { Application } from "@/types";
import { foldStatus } from "@/features/applied/status-map";

export { ApplicationConflictError };

export class UnknownJobError extends Error {
  constructor(jobId: string) {
    super(`No job with id "${jobId}".`);
    this.name = "UnknownJobError";
  }
}

// 409 CONFLICT (mirrors server/tailor, server/apply-assistant): v1 holds
// exactly one active résumé (resumes.isActive) and `applications.resumeId`
// is a NOT NULL FK — marking a job applied always records which résumé was
// active at the time, so this must exist before insert.
export class NoActiveResumeError extends Error {
  constructor(message = "No résumé exists — marking a job applied requires an active résumé.") {
    super(message);
    this.name = "NoActiveResumeError";
  }
}

// `Application.tailored` is not a stored column — it's derived from
// `tailoredResumeId` (non-null = a tailored résumé is linked to this
// application), so there's exactly one source of truth for the fact instead
// of two columns that could drift apart.
function toApplication(row: AppJoinJobScore): Application {
  return Application.parse({
    id: row.id,
    jobId: row.jobId,
    role: row.role,
    company: row.company,
    meta: row.meta,
    appliedAt: row.appliedAt.toISOString(),
    score: row.score,
    stage: row.stage,
    statusLabel: row.statusLabel,
    statusTone: row.statusTone,
    tailored: row.tailoredResumeId !== null,
    note: row.note,
    tailoredResumeId: row.tailoredResumeId,
    answersId: row.answersId,
  });
}

export interface MarkAppliedInput {
  jobId: string;
  note?: string;
  tailoredResumeId?: string;
  answersId?: string;
}

export async function markApplied(input: MarkAppliedInput): Promise<Application> {
  if (!(await jobsRepo.existsById(input.jobId))) throw new UnknownJobError(input.jobId);

  const resumeRow = await resumesRepo.getActive();
  if (!resumeRow) throw new NoActiveResumeError();

  const folded = foldStatus(0, "open");

  const inserted = await applicationsRepo.insertUniqueByJob({
    jobId: input.jobId,
    resumeId: resumeRow.id,
    tailoredResumeId: input.tailoredResumeId ?? null,
    answersId: input.answersId ?? null,
    stage: 0,
    statusLabel: folded.statusLabel,
    statusTone: folded.statusTone,
    note: input.note ?? "",
  });

  const joined = await applicationsRepo.getJoined(inserted.id);
  if (!joined) throw new Error(`applications row ${inserted.id} vanished (or unscored) right after insert`);
  return toApplication(joined);
}

export interface ListApplicationsQuery {
  stage?: 0 | 1 | 2 | 3;
  statusTone?: "good" | "verified" | "neutral";
  cursor?: string;
  limit?: number;
}

export async function listApplications(
  q: ListApplicationsQuery,
): Promise<{ items: Application[]; nextCursor: string | null }> {
  const { items, nextCursor } = await applicationsRepo.listJoined(q);
  return { items: items.map(toApplication), nextCursor };
}

export type PatchApplicationInput = Partial<{
  stage: 0 | 1 | 2 | 3;
  statusLabel: string;
  statusTone: "good" | "verified" | "neutral";
  note: string;
  tailored: boolean;
  tailoredResumeId: string | null;
  answersId: string | null;
}>;

// A manual statusLabel/statusTone always wins (explicit override). Only when
// BOTH are absent from the patch does a stage move re-fold a default via
// foldStatus(newStage, 'open') (task-B9-brief.md behaviour). `tailored` is
// accepted (locked interface) but never persisted — it's derived from
// `tailoredResumeId` on every read (see toApplication above), so patching it
// alone is a no-op; pair it with `tailoredResumeId` to actually change it.
export async function patchApplication(id: string, patch: PatchApplicationInput): Promise<Application | null> {
  const { tailored: _tailored, ...rest } = patch;

  const shouldRefold = rest.stage !== undefined && rest.statusLabel === undefined && rest.statusTone === undefined;
  const toApply = shouldRefold ? { ...rest, ...foldStatus(rest.stage!, "open") } : rest;

  const updated = await applicationsRepo.patch(id, toApply);
  if (!updated) return null;

  const joined = await applicationsRepo.getJoined(id);
  if (!joined) throw new Error(`applications row ${id} vanished right after patch`);
  return toApplication(joined);
}
