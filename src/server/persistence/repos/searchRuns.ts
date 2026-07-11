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
    // system-architecture.md §6 decision 2: "A restart kills a run (status
    // running → mark stale on boot)" — there is no distinct 'stale' wire/DB
    // status, so staleness is represented as `failed` with an explanatory
    // `error`. Called once by server/runs/registry.ts on process start.
    async markAllRunningAsFailed(errorMessage: string): Promise<SearchRunRow[]> {
      return db
        .update(searchRuns)
        .set({ status: "failed", error: errorMessage, finishedAt: new Date() })
        .where(eq(searchRuns.status, "running"))
        .returning();
    },
  };
}

export const searchRunsRepo: ReturnType<typeof createSearchRunsRepo> = {
  insert: (row) => createSearchRunsRepo(getDb()).insert(row),
  getById: (id) => createSearchRunsRepo(getDb()).getById(id),
  updateStatus: (id, status, patch) => createSearchRunsRepo(getDb()).updateStatus(id, status, patch),
  updateStats: (id, stats) => createSearchRunsRepo(getDb()).updateStats(id, stats),
  markAllRunningAsFailed: (errorMessage) => createSearchRunsRepo(getDb()).markAllRunningAsFailed(errorMessage),
};
