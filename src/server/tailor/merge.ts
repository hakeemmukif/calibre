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
  constructor(message: string) {
    super(message);
    this.name = "InvalidDiffIndexError";
  }
}

export class UnknownDiffSectionError extends Error {
  constructor(section: string) {
    super(`diff entry names section "${section}", which is not a résumé top-level field the merge understands.`);
    this.name = "UnknownDiffSectionError";
  }
}

export class MalformedDiffEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedDiffEditError";
  }
}

const SCALAR_SECTIONS = ["summary", "headline"] as const;

export function applyEdits(base: ResumeStore, edits: TailorDiffEntry[]): ResumeStore {
  const next = structuredClone(base);

  // Multi-edit lists are grouped by their target list identity
  // (section + target.index) so that within a list, edits are re-ordered
  // into a base-index-safe sequence before any splice happens — otherwise
  // a `remove` at a lower bulletIndex shifts a later edit's base-relative
  // index and it silently lands on the wrong bullet.
  const groups = new Map<string, TailorDiffEntry[]>();
  for (const e of edits) {
    if ((SCALAR_SECTIONS as readonly string[]).includes(e.section)) {
      applyScalar(next, e);
      continue;
    }
    const key = `${e.section}:${e.target.index}`;
    const group = groups.get(key);
    if (group) group.push(e);
    else groups.set(key, [e]);
  }
  for (const group of groups.values()) applyGroup(next, group);
  return next;
}

export function applyAcceptedDiff(
  base: ResumeStore,
  diff: TailorDiffEntry[],
  acceptedIndices: number[],
): ResumeStore {
  const accepted = [...new Set(acceptedIndices)].map((i) => {
    if (i < 0 || i >= diff.length) {
      throw new InvalidDiffIndexError(`acceptedIndices contains ${i}, out of range for a diff[] of length ${diff.length}.`);
    }
    return diff[i];
  });
  return applyEdits(base, accepted);
}

function applyScalar(store: ResumeStore, e: TailorDiffEntry): void {
  const field = e.section as "summary" | "headline";
  if (e.op === "remove") {
    store[field] = undefined;
    return;
  }
  // add/modify
  if (!e.after) {
    throw new MalformedDiffEditError(`${e.op} edit for section "${e.section}" is missing "after".`);
  }
  // `before` is the human-review anchor (see applyBullet below) — a
  // `modify` that omits it bypasses that anchor entirely, so this is
  // defense in depth against a caller that skipped TailorResultSchema's own
  // (stricter) mandatory-`before` check.
  if (e.op === "modify" && e.before === undefined) {
    throw new MalformedDiffEditError(`modify edit for section "${e.section}" is missing "before" (the anchor a reviewer's accept/reject decision is based on) — refusing to blindly rewrite.`);
  }
  store[field] = e.after;
}

function applyGroup(store: ResumeStore, edits: TailorDiffEntry[]): void {
  const first = edits[0];
  const list = resolveList(store, first.section, first.target.index);

  const modifies = edits.filter((e) => e.op === "modify");
  const removes = edits
    .filter((e) => e.op === "remove")
    .sort((a, b) => (b.target.bulletIndex ?? -1) - (a.target.bulletIndex ?? -1));
  const adds = edits.filter((e) => e.op === "add");

  // Base-relative bulletIndex is only safe to read before the list has
  // shrunk, so: modify (index-stable) -> remove descending (earlier
  // removes don't shift later ones) -> add (appends, order-independent).
  for (const e of modifies) applyBullet(list, e);
  for (const e of removes) applyBullet(list, e);
  for (const e of adds) applyBullet(list, e);
}

function resolveList(store: ResumeStore, section: string, index: number | null): string[] {
  switch (section) {
    case "experience": {
      const role = store.experience[index ?? -1];
      if (!role) {
        throw new InvalidDiffIndexError(`target.index ${index} is out of range for résumé section "experience" (length ${store.experience.length}).`);
      }
      return role.bullets;
    }
    case "projects": {
      const proj = store.projects[index ?? -1];
      if (!proj) {
        throw new InvalidDiffIndexError(`target.index ${index} is out of range for résumé section "projects" (length ${store.projects.length}).`);
      }
      return proj.bullets;
    }
    case "skills": {
      const group = store.skills[index ?? -1];
      if (!group) {
        throw new InvalidDiffIndexError(`target.index ${index} is out of range for résumé section "skills" (length ${store.skills.length}).`);
      }
      return group.items;
    }
    default:
      throw new UnknownDiffSectionError(section);
  }
}

function applyBullet(list: string[], e: TailorDiffEntry): void {
  if (e.op === "add") {
    if (!e.after) {
      throw new MalformedDiffEditError(`add edit for section "${e.section}" is missing "after".`);
    }
    list.push(e.after);
    return;
  }
  if (e.target.bulletIndex == null) {
    throw new InvalidDiffIndexError(`op "${e.op}" on section "${e.section}" requires a non-null target.bulletIndex.`);
  }
  const i = e.target.bulletIndex;
  if (i < 0 || i >= list.length) {
    throw new InvalidDiffIndexError(`target.bulletIndex ${i} is out of range for section "${e.section}" bullets (length ${list.length}).`);
  }
  if (e.op === "remove") {
    list.splice(i, 1);
    return;
  }
  // modify
  if (!e.after) {
    throw new MalformedDiffEditError(`modify edit for section "${e.section}" is missing "after".`);
  }
  // `before` is the human-review anchor: a reviewer accepts an edit based on
  // the shown before-text, so a stale/mismatched edit must never silently
  // rewrite a different bullet. An absent `before` is defense in depth
  // against a caller that skipped TailorResultSchema's own (stricter)
  // mandatory-`before` check — it must fail loud, not be treated as "no
  // anchor to check". Modifies apply before removes within a group (see
  // applyGroup), so `list[i]` is still the base bullet here.
  if (e.before === undefined) {
    throw new MalformedDiffEditError(
      `modify edit for section "${e.section}" bulletIndex ${i} is missing "before" (the anchor a reviewer's accept/reject decision is based on) — refusing to blindly rewrite.`,
    );
  }
  if (list[i] !== e.before) {
    throw new MalformedDiffEditError(
      `modify edit for section "${e.section}" bulletIndex ${i} expected before "${e.before}" but found "${list[i]}".`,
    );
  }
  list[i] = e.after;
}
