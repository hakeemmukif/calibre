import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { resumes } from "../schema";
import type { Db } from "./db";

export type NewResume = typeof resumes.$inferInsert;
export type ResumeRow = typeof resumes.$inferSelect;

// v1 holds exactly one active résumé (§1 `resumes.isActive`) — a new upload
// atomically supersedes whatever was active (api-contract.md "Idempotent-by-
// replacement"). Forces `isActive: true` on the inserted row regardless of
// the caller's input: that's the entire point of this method's name.
export function createResumesRepo(db: Db) {
  return {
    async insertReplacingActive(row: NewResume): Promise<ResumeRow> {
      return db.transaction(async (tx) => {
        await tx.update(resumes).set({ isActive: false }).where(eq(resumes.isActive, true));
        const [inserted] = await tx
          .insert(resumes)
          .values({ ...row, isActive: true })
          .returning();
        return inserted;
      });
    },
    async getActive(): Promise<ResumeRow | null> {
      const [row] = await db.select().from(resumes).where(eq(resumes.isActive, true)).limit(1);
      return row ?? null;
    },
    async getById(id: string): Promise<ResumeRow | null> {
      const [row] = await db.select().from(resumes).where(eq(resumes.id, id)).limit(1);
      return row ?? null;
    },
  };
}

// Lazily bound to the real Postgres client — only resolved when a method is
// actually invoked, so importing this module never requires `DATABASE_URL`
// (tests use `createResumesRepo(testDb)` directly and never touch this).
export const resumesRepo: ReturnType<typeof createResumesRepo> = {
  insertReplacingActive: (row) => createResumesRepo(getDb()).insertReplacingActive(row),
  getActive: () => createResumesRepo(getDb()).getActive(),
  getById: (id) => createResumesRepo(getDb()).getById(id),
};
