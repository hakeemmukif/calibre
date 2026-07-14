import { and, eq } from "drizzle-orm";
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
    async getById(id: string, userId: string): Promise<ApplicationAnswersRow | null> {
      const [row] = await db
        .select()
        .from(applicationAnswers)
        .where(and(eq(applicationAnswers.id, id), eq(applicationAnswers.userId, userId)))
        .limit(1);
      return row ?? null;
    },
    // B7 PATCH /api/apply/answers/:id — replaces the persisted answer set
    // (user edits and per-question regenerate/redraft alike). Returns null
    // for an unknown id rather than throwing — the caller (patchAnswers)
    // maps that to a 404.
    // By-uuid PATCH leak fix (Fable design review, CRITICAL): scoped by
    // userId so a foreign answers id no-ops instead of overwriting another
    // tenant's drafted answers.
    async update(
      id: string,
      userId: string,
      answers: NewApplicationAnswers["answers"],
    ): Promise<ApplicationAnswersRow | null> {
      const [row] = await db
        .update(applicationAnswers)
        .set({ answers })
        .where(and(eq(applicationAnswers.id, id), eq(applicationAnswers.userId, userId)))
        .returning();
      return row ?? null;
    },
  };
}

export const applicationAnswersRepo: ReturnType<typeof createApplicationAnswersRepo> = {
  insert: (row) => createApplicationAnswersRepo(getDb()).insert(row),
  getById: (id, userId) => createApplicationAnswersRepo(getDb()).getById(id, userId),
  update: (id, userId, answers) => createApplicationAnswersRepo(getDb()).update(id, userId, answers),
};
