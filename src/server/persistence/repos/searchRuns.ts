import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { searchRuns } from "../schema";
import type { Db } from "./db";

export type NewSearchRun = typeof searchRuns.$inferInsert;
export type SearchRunRow = typeof searchRuns.$inferSelect;

export function createSearchRunsRepo(db: Db) {
  return {
    async insert(row: NewSearchRun): Promise<SearchRunRow> {
      const [inserted] = await db.insert(searchRuns).values(row).returning();
      return inserted;
    },
    async getById(id: string): Promise<SearchRunRow | null> {
      const [row] = await db.select().from(searchRuns).where(eq(searchRuns.id, id)).limit(1);
      return row ?? null;
    },
    async updateStatus(
      id: string,
      status: SearchRunRow["status"],
      patch?: { finishedAt?: Date; error?: string },
    ): Promise<SearchRunRow | null> {
      const [updated] = await db
        .update(searchRuns)
        .set({ status, ...patch })
        .where(eq(searchRuns.id, id))
        .returning();
      return updated ?? null;
    },
    async updateStats(id: string, stats: SearchRunRow["stats"]): Promise<SearchRunRow | null> {
      const [updated] = await db.update(searchRuns).set({ stats }).where(eq(searchRuns.id, id)).returning();
      return updated ?? null;
    },
  };
}

export const searchRunsRepo: ReturnType<typeof createSearchRunsRepo> = {
  insert: (row) => createSearchRunsRepo(getDb()).insert(row),
  getById: (id) => createSearchRunsRepo(getDb()).getById(id),
  updateStatus: (id, status, patch) => createSearchRunsRepo(getDb()).updateStatus(id, status, patch),
  updateStats: (id, stats) => createSearchRunsRepo(getDb()).updateStats(id, stats),
};
