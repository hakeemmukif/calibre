// Accepted-only merge (task-B8 brief §"Behaviour", reworked for the review
// pass's Finding 2 fix): shared by finalizeTailor/renderTailorPdf (index.ts,
// which validate + persist the accepted index set) and assemble.ts (which
// recomputes the merged view on every read) — `structured` is never
// overwritten in place, so re-finalize with a different accepted set is
// always correct.
import type { ResumeStore } from "@/server/resume/resume-store";
import { TailoredResume } from "@/types";
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

// Only top-level ResumeStore fields the accepted-only merge knows how to
// apply per diff entry — a `section` outside this set fails loud rather
// than silently no-op'ing (constraints: fail loud, no fallback).
const MERGEABLE_SECTIONS = new Set<keyof ResumeStore>([
  "name",
  "headline",
  "summary",
  "contact",
  "experience",
  "education",
  "skills",
  "projects",
  "certifications",
  "languages",
  "sections",
]);

// KNOWN LIMITATION (task-B8 review pass, Finding 1): `diff[]` is a frozen
// string-only shape, and TailorResultSchema now enforces exactly one entry
// per section — so accept/reject is whole-section granularity only.
// Per-sub-item accept/reject (e.g. one bullet within `experience`) is not
// expressible with this shape; a contract revision (e.g. stable per-item
// ids) would be needed for finer granularity.
export function applyAcceptedDiff(
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
