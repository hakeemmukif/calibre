import { eq } from "drizzle-orm";
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
    async getById(id: string): Promise<TailoredResumeRow | null> {
      const [row] = await db.select().from(tailoredResumes).where(eq(tailoredResumes.id, id)).limit(1);
      return row ?? null;
    },
    async updateStatus(id: string, status: TailoredResumeRow["status"]): Promise<TailoredResumeRow | null> {
      const [updated] = await db.update(tailoredResumes).set({ status }).where(eq(tailoredResumes.id, id)).returning();
      return updated ?? null;
    },
    // B8 startTailor's async completion: persists the LLM's tailored
    // ResumeStore + diff[] + the model/cost that actually produced it, and
    // flips status -> 'completed'. `finalizedAt` is untouched (still null).
    async complete(
      id: string,
      patch: {
        structured: TailoredResumeRow["structured"];
        diff: TailoredResumeRow["diff"];
        model: string;
        costUsd: number;
        completedAt: Date;
      },
    ): Promise<TailoredResumeRow | null> {
      const [updated] = await db
        .update(tailoredResumes)
        .set({ status: "completed", ...patch })
        .where(eq(tailoredResumes.id, id))
        .returning();
      return updated ?? null;
    },
    // B8 finalizeTailor: overwrites `structured` with the accepted-only merged
    // ResumeStore (so the PDF route renders exactly what was finalized) and
    // sets `finalizedAt`. Status stays 'completed'.
    async finalize(
      id: string,
      patch: { structured: TailoredResumeRow["structured"]; finalizedAt: Date },
    ): Promise<TailoredResumeRow | null> {
      const [updated] = await db.update(tailoredResumes).set(patch).where(eq(tailoredResumes.id, id)).returning();
      return updated ?? null;
    },
    // Mirrors search/run.ts's failRun crash-safety net — an unexpected error
    // during the async tailor job flips the row to 'failed' rather than
    // leaving it stuck 'running' forever.
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
  getById: (id) => createTailoredResumesRepo(getDb()).getById(id),
  updateStatus: (id, status) => createTailoredResumesRepo(getDb()).updateStatus(id, status),
  complete: (id, patch) => createTailoredResumesRepo(getDb()).complete(id, patch),
  finalize: (id, patch) => createTailoredResumesRepo(getDb()).finalize(id, patch),
  markFailed: (id) => createTailoredResumesRepo(getDb()).markFailed(id),
};
