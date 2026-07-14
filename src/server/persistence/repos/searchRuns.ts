import { and, desc, eq, inArray } from "drizzle-orm";
import type { ScanPersona } from "@/types";
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
    async getById(id: string, userId: string): Promise<SearchRunRow | null> {
      const [row] = await db
        .select()
        .from(searchRuns)
        .where(and(eq(searchRuns.id, id), eq(searchRuns.userId, userId)))
        .limit(1);
      return row ?? null;
    },
    // task-B6-brief.md `sinceLast`/wire-`isNew` cutoff: "the previous
    // COMPLETED search run's finishedAt". `personas` is a jsonb array
    // (both-persona runs are possible), so persona containment is filtered
    // in JS rather than a jsonb `@>` SQL operator — dataset is single-
    // operator-MVP small (a handful of runs at most).
    async getLatestCompleted(userId: string, persona?: ScanPersona): Promise<SearchRunRow | null> {
      const rows = await db
        .select()
        .from(searchRuns)
        .where(and(eq(searchRuns.status, "completed"), eq(searchRuns.userId, userId)))
        .orderBy(desc(searchRuns.finishedAt));
      const match = persona ? rows.find((r) => r.personas.includes(persona)) : rows[0];
      return match ?? null;
    },
    // GLOBAL-BY-DECISION: async run-engine completion write (server/search/
    // run.ts) — `id` is the runId this same process created/claimed via
    // `insert`/`getById`, never an attacker-supplied route param, so there is
    // no separate tenant to scope against here.
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
    // GLOBAL-BY-DECISION: same as updateStatus above — internal run-engine
    // write keyed on a runId this process already owns.
    async updateStats(id: string, stats: SearchRunRow["stats"]): Promise<SearchRunRow | null> {
      const [updated] = await db.update(searchRuns).set({ stats }).where(eq(searchRuns.id, id)).returning();
      return updated ?? null;
    },
    // GLOBAL-BY-DECISION: system-architecture.md §6 decision 2: "A restart
    // kills a run (status running → mark stale on boot)" — there is no
    // distinct 'stale' wire/DB status, so staleness is represented as
    // `failed` with an explanatory `error`. Both 'queued' and 'running' rows
    // are orphaned by a restart: a 'queued' row was inserted pre-fan-out, so
    // no in-memory handle can exist for it either once the process (and its
    // registry) is gone. Called once by server/runs/registry.ts on process
    // start, across every tenant's rows — infra, not request-scoped.
    async markAllUnfinishedAsFailed(errorMessage: string): Promise<SearchRunRow[]> {
      return db
        .update(searchRuns)
        .set({ status: "failed", error: errorMessage, finishedAt: new Date() })
        .where(inArray(searchRuns.status, ["queued", "running"]))
        .returning();
    },
  };
}

export const searchRunsRepo: ReturnType<typeof createSearchRunsRepo> = {
  insert: (row) => createSearchRunsRepo(getDb()).insert(row),
  getById: (id, userId) => createSearchRunsRepo(getDb()).getById(id, userId),
  getLatestCompleted: (userId, persona) => createSearchRunsRepo(getDb()).getLatestCompleted(userId, persona),
  updateStatus: (id, status, patch) => createSearchRunsRepo(getDb()).updateStatus(id, status, patch),
  updateStats: (id, stats) => createSearchRunsRepo(getDb()).updateStats(id, stats),
  markAllUnfinishedAsFailed: (errorMessage) =>
    createSearchRunsRepo(getDb()).markAllUnfinishedAsFailed(errorMessage),
};
