// DB row -> wire `TailoredResume` (api-contract.md §2). `progress` is always
// null here (mirrors server/search/assemble-run.ts) — live progress is
// ephemeral (server/runs/registry.ts), never persisted; this is the
// polling/terminal snapshot. `resume` is derived fresh on every call: the
// full tailored draft before finalize, or (task-B8 review pass, Finding 2)
// the accepted-only merge of base résumé + the immutable tailored
// `structured` + the row's persisted `acceptedIndices` after finalize —
// `structured` itself is never overwritten, so this always reflects the
// LAST finalize. atsScore is always recomputed, never stored.
import { resumesRepo } from "@/server/persistence/repos/resumes";
import type { TailoredResumeRow } from "@/server/persistence/repos/tailoredResumes";
import { computeAtsScore } from "@/server/resume/atsScore";
import { toResumeView } from "@/server/resume/derive-view";
import type { ResumeStore } from "@/server/resume/resume-store";
import { TailoredResume } from "@/types";
import { applyAcceptedDiff } from "./merge";

function toResumeSummaryView(store: ResumeStore, updatedAt: Date): TailoredResume["resume"] {
  const full = toResumeView(store, {
    id: "unused", // stripped below — Resume.omit({id,rawText}) never exposes this
    atsScore: computeAtsScore(store),
    updatedAt: updatedAt.toISOString(),
    rawText: "", // stripped below
  });
  const { id: _id, rawText: _rawText, ...view } = full;
  return view;
}

export async function toTailoredResume(row: TailoredResumeRow): Promise<TailoredResume> {
  let resumeStore: ResumeStore | null = row.structured;
  if (row.structured && row.finalizedAt) {
    if (!row.acceptedIndices) {
      throw new Error(`tailored_resumes ${row.id}: finalizedAt is set but acceptedIndices is null`);
    }
    // row.userId is the tailored_resumes row's real owner (a DB fact, not a
    // scaffold) — the base résumé it points to was inserted for that same user.
    const baseResumeRow = await resumesRepo.getById(row.baseResumeId, row.userId);
    if (!baseResumeRow) {
      throw new Error(`tailored_resumes ${row.id}: base résumé ${row.baseResumeId} no longer exists`);
    }
    resumeStore = applyAcceptedDiff(baseResumeRow.structured, row.structured, row.diff, row.acceptedIndices);
  }

  return TailoredResume.parse({
    id: row.id,
    jobId: row.jobId,
    resumeId: row.baseResumeId,
    status: row.status,
    progress: null,
    resume: resumeStore ? toResumeSummaryView(resumeStore, row.finalizedAt ?? row.completedAt ?? row.createdAt) : null,
    diff: row.diff,
    model: row.model,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  });
}
