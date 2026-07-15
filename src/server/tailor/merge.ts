// Bullet-addressable merge (task-9 brief): retires the whole-section-copy
// approach — each diff entry carries its own `after` value plus a `target`
// (role/skill-group index + bulletIndex), so accept/reject is per-bullet
// granularity, not per-section. Shared by finalizeTailor/renderTailorPdf
// (index.ts, which validate + persist the accepted index set) and
// assemble.ts (which recomputes the merged view on every read) —
// `base` is never overwritten in place, so re-finalize with a different
// accepted set is always correct.
import type { ResumeStore } from "@/server/resume/resume-store";
import { TailoredResume } from "@/types";
import type { TailorDiffEntry } from "@/types";
import { z } from "zod";

// Frozen TailoredResume.diff shape (src/types), reused verbatim so this
// schema can never drift from the wire contract.
export const DiffEntrySchema = TailoredResume.shape.diff.element;
export type DiffEntry = z.infer<typeof DiffEntrySchema>;

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

export function applyEdits(base: ResumeStore, edits: TailorDiffEntry[]): ResumeStore {
  const next = structuredClone(base);
  for (const e of edits) applyOne(next, e);
  return next;
}

export function applyAcceptedDiff(
  base: ResumeStore,
  diff: TailorDiffEntry[],
  acceptedIndices: number[],
): ResumeStore {
  const accepted = acceptedIndices.map((i) => {
    if (i < 0 || i >= diff.length) throw new InvalidDiffIndexError(i, diff.length);
    return diff[i];
  });
  return applyEdits(base, accepted);
}

function applyOne(store: ResumeStore, e: TailorDiffEntry): void {
  switch (e.section) {
    case "summary":
      store.summary = e.after ?? undefined;
      return;
    case "headline":
      store.headline = e.after ?? undefined;
      return;
    case "experience": {
      const role = store.experience[e.target.index ?? -1];
      if (!role) throw new InvalidDiffIndexError(e.target.index ?? -1, store.experience.length);
      if (e.target.bulletIndex == null) return; // whole-role edits unsupported in v1
      applyBullet(role.bullets, e);
      return;
    }
    case "projects": {
      const proj = store.projects[e.target.index ?? -1];
      if (!proj) throw new InvalidDiffIndexError(e.target.index ?? -1, store.projects.length);
      if (e.target.bulletIndex == null) return;
      applyBullet(proj.bullets, e);
      return;
    }
    case "skills": {
      const group = store.skills[e.target.index ?? -1];
      if (!group) throw new InvalidDiffIndexError(e.target.index ?? -1, store.skills.length);
      applyBullet(group.items, e);
      return;
    }
    default:
      throw new UnknownDiffSectionError(e.section);
  }
}

function applyBullet(list: string[], e: TailorDiffEntry): void {
  if (e.op === "add") {
    if (e.after) list.push(e.after);
    return;
  }
  const i = e.target.bulletIndex ?? -1;
  if (i < 0 || i >= list.length) throw new InvalidDiffIndexError(i, list.length);
  if (e.op === "remove") {
    list.splice(i, 1);
    return;
  }
  if (e.after) list[i] = e.after; // modify
}
