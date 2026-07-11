// DB row -> wire `TailoredResume` (api-contract.md §2). `progress` is always
// null here (mirrors server/search/assemble-run.ts) — live progress is
// ephemeral (server/runs/registry.ts), never persisted; this is the
// polling/terminal snapshot. `resume` is derived fresh from whatever
// `structured` currently holds: the full tailored draft before finalize, the
// accepted-only merge after (finalizeTailor overwrites `structured` in
// place) — so atsScore is always recomputed, never stored.
import type { TailoredResumeRow } from "@/server/persistence/repos/tailoredResumes";
import { computeAtsScore } from "@/server/resume/atsScore";
import { toResumeView } from "@/server/resume/derive-view";
import type { ResumeStore } from "@/server/resume/resume-store";
import { TailoredResume } from "@/types";

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

export function toTailoredResume(row: TailoredResumeRow): TailoredResume {
  return TailoredResume.parse({
    id: row.id,
    jobId: row.jobId,
    resumeId: row.baseResumeId,
    status: row.status,
    progress: null,
    resume: row.structured ? toResumeSummaryView(row.structured, row.finalizedAt ?? row.completedAt ?? row.createdAt) : null,
    diff: row.diff,
    model: row.model,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  });
}
