import { and, eq } from "drizzle-orm";
import { getDb } from "../db";
import { tailoredResumes } from "../schema";
import type { Db } from "./db";

export type NewTailoredResume = typeof tailoredResumes.$inferInsert;
export type TailoredResumeRow = typeof tailoredResumes.$inferSelect;

export function createTailoredResumesRepo(db: Db) {
  return {
    async insert(row: NewTailoredResume): Promise<TailoredResumeRow> {
      const [inserted] = await db.insert(tailoredResumes).values(row).returning();
      return inserted;
    },
    async getById(id: string, userId: string): Promise<TailoredResumeRow | null> {
      const [row] = await db
        .select()
        .from(tailoredResumes)
        .where(and(eq(tailoredResumes.id, id), eq(tailoredResumes.userId, userId)))
        .limit(1);
      return row ?? null;
    },
    // GLOBAL-BY-DECISION: async tailor-job completion write (server/tailor/
    // index.ts) — `id` is the row this same process just inserted, never an
    // attacker-supplied route param, so there is no separate tenant to scope
    // against here.
    async updateStatus(id: string, status: TailoredResumeRow["status"]): Promise<TailoredResumeRow | null> {
      const [updated] = await db.update(tailoredResumes).set({ status }).where(eq(tailoredResumes.id, id)).returning();
      return updated ?? null;
    },
    // B8 startTailor's async completion: persists the LLM's tailored
    // ResumeStore + diff[] + the model/cost that actually produced it, and
    // flips status -> 'completed'. `finalizedAt` is untouched (still null).
    // `reportId` is optional: a row started WITH a reportId already carries
    // it from insert(); a row started without one gets it filled in here
    // once startTailor's report resolution (index.ts) has run `correlate`
    // and knows which report drove the rewrite.
    // GLOBAL-BY-DECISION: same as updateStatus above — internal job-engine
    // write keyed on a row this process already owns.
    async complete(
      id: string,
      patch: {
        structured: TailoredResumeRow["structured"];
        diff: TailoredResumeRow["diff"];
        model: string;
        costUsd: number;
        completedAt: Date;
        reportId?: TailoredResumeRow["reportId"];
      },
    ): Promise<TailoredResumeRow | null> {
      const [updated] = await db
        .update(tailoredResumes)
        .set({ status: "completed", ...patch })
        .where(eq(tailoredResumes.id, id))
        .returning();
      return updated ?? null;
    },
    // task-B8 review pass, Finding 2: finalize persists the accepted index
    // set + `finalizedAt` only — `structured` is never overwritten, so a
    // second finalize with a different accepted set always has the full
    // tailored draft to recompute from (server/tailor/merge.ts's
    // applyAcceptedDiff, called fresh on every read). Status stays
    // 'completed'.
    // GLOBAL-BY-DECISION: `id` here is already ownership-checked by the
    // caller — finalizeTailor (server/tailor/index.ts) fetches the row via
    // the scoped `getById(id, userId)` first and only reaches this write
    // once that lookup succeeds; no separate check needed here.
    async finalize(
      id: string,
      patch: { acceptedIndices: number[]; finalizedAt: Date; atsDelta: { before: number; after: number; total: number } | null },
    ): Promise<TailoredResumeRow | null> {
      const [updated] = await db.update(tailoredResumes).set(patch).where(eq(tailoredResumes.id, id)).returning();
      return updated ?? null;
    },
    // Mirrors search/run.ts's failRun crash-safety net — an unexpected error
    // during the async tailor job flips the row to 'failed' rather than
    // leaving it stuck 'running' forever.
    // GLOBAL-BY-DECISION: internal crash-recovery write keyed on a row this
    // process itself just created, never an attacker-supplied route param.
    async markFailed(id: string): Promise<TailoredResumeRow | null> {
      const [updated] = await db
        .update(tailoredResumes)
        .set({ status: "failed" })
        .where(eq(tailoredResumes.id, id))
        .returning();
      return updated ?? null;
    },
  };
}

export const tailoredResumesRepo: ReturnType<typeof createTailoredResumesRepo> = {
  insert: (row) => createTailoredResumesRepo(getDb()).insert(row),
  getById: (id, userId) => createTailoredResumesRepo(getDb()).getById(id, userId),
  updateStatus: (id, status) => createTailoredResumesRepo(getDb()).updateStatus(id, status),
  complete: (id, patch) => createTailoredResumesRepo(getDb()).complete(id, patch),
  finalize: (id, patch) => createTailoredResumesRepo(getDb()).finalize(id, patch),
  markFailed: (id) => createTailoredResumesRepo(getDb()).markFailed(id),
};
