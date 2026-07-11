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
  };
}

export const tailoredResumesRepo: ReturnType<typeof createTailoredResumesRepo> = {
  insert: (row) => createTailoredResumesRepo(getDb()).insert(row),
  getById: (id) => createTailoredResumesRepo(getDb()).getById(id),
};
