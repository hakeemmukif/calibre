import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { applicationAnswers } from "../schema";
import type { Db } from "./db";

export type NewApplicationAnswers = typeof applicationAnswers.$inferInsert;
export type ApplicationAnswersRow = typeof applicationAnswers.$inferSelect;

export function createApplicationAnswersRepo(db: Db) {
  return {
    async insert(row: NewApplicationAnswers): Promise<ApplicationAnswersRow> {
      const [inserted] = await db.insert(applicationAnswers).values(row).returning();
      return inserted;
    },
    async getById(id: string): Promise<ApplicationAnswersRow | null> {
      const [row] = await db.select().from(applicationAnswers).where(eq(applicationAnswers.id, id)).limit(1);
      return row ?? null;
    },
    // B7 PATCH /api/apply/answers/:id — replaces the persisted answer set
    // (user edits and per-question regenerate/redraft alike). Returns null
    // for an unknown id rather than throwing — the caller (patchAnswers)
    // maps that to a 404.
    async update(id: string, answers: NewApplicationAnswers["answers"]): Promise<ApplicationAnswersRow | null> {
      const [row] = await db
        .update(applicationAnswers)
        .set({ answers })
        .where(eq(applicationAnswers.id, id))
        .returning();
      return row ?? null;
    },
  };
}

export const applicationAnswersRepo: ReturnType<typeof createApplicationAnswersRepo> = {
  insert: (row) => createApplicationAnswersRepo(getDb()).insert(row),
  getById: (id) => createApplicationAnswersRepo(getDb()).getById(id),
  update: (id, answers) => createApplicationAnswersRepo(getDb()).update(id, answers),
};
