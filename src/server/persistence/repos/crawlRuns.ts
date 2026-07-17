import { and, desc, eq, isNotNull } from "drizzle-orm";
import { getDb } from "../db";
import { crawlRuns } from "../schema";
import type { Db } from "./db";

export function createCrawlRunsRepo(db: Db) {
  return {
    // GLOBAL-BY-DECISION: crawl_runs is system-owned reference data (arch §7.2 —
    // no user_id; the pool it describes is shared across all tenants).
    // F4 (arch §7.1): the "last successful crawl" freshness fact P.5's scan SSE
    // reads to fail loud when the pool is stale (>48h). `null` = no completed
    // crawl has ever finished — the pool may never have filled (equally a
    // freshness warning, decided by the caller). No `db.transaction`.
    async latestSuccessfulFinishedAt(): Promise<Date | null> {
      const [row] = await db
        .select({ finishedAt: crawlRuns.finishedAt })
        .from(crawlRuns)
        .where(and(eq(crawlRuns.status, "completed"), isNotNull(crawlRuns.finishedAt)))
        .orderBy(desc(crawlRuns.finishedAt))
        .limit(1);
      return row?.finishedAt ?? null;
    },
  };
}

export const crawlRunsRepo: ReturnType<typeof createCrawlRunsRepo> = {
  latestSuccessfulFinishedAt: () => createCrawlRunsRepo(getDb()).latestSuccessfulFinishedAt(),
};
