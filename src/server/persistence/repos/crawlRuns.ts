// Crawl status panel (admin surface) — aggregate reads over `crawl_runs` +
// `postings`. GLOBAL-BY-DECISION throughout: both tables are system-owned
// (no userId), same dimension as postingsRepo/sourcesRepo.
import { and, desc, eq, gte, isNotNull, ne, sql } from "drizzle-orm";
import { getDb } from "../db";
import { crawlRuns, postings, sources } from "../schema";
import type { Db } from "./db";

export type CrawlRunRow = typeof crawlRuns.$inferSelect;

export interface PoolCounts {
  live: number;
  delisted: number;
  total: number;
}

export interface RunningCrawlAgg {
  startedAt: Date;
  postingsSeenThisRun: number;
  sourcesWrittenThisRun: number;
}

export interface PerSourceRow {
  sourceId: string;
  name: string;
  liveCount: number;
  lastSeenAt: Date | null;
}

// A `running` row younger than this is the crawl in flight (mirrors
// crawler.ts's own overlap lease, arch §7.3) — an older running row is a
// crashed/orphaned lease, not a live crawl, so it must not surface here.
const LEASE_MS = 2 * 60 * 60 * 1000;

export function createCrawlRunsRepo(db: Db) {
  return {
    async getPoolCounts(): Promise<PoolCounts> {
      const [row] = await db
        .select({
          live: sql<string>`count(case when ${postings.delistedAt} is null then 1 end)`,
          delisted: sql<string>`count(case when ${postings.delistedAt} is not null then 1 end)`,
          total: sql<string>`count(*)`,
        })
        .from(postings);
      return { live: Number(row.live), delisted: Number(row.delisted), total: Number(row.total) };
    },

    // GLOBAL-BY-DECISION: `crawl_runs` is a system-owned table (no userId,
    // same dimension as sources/postings) — this is the admin staleness
    // surface reading the whole crawl history, not a per-user resource.
    async latestSuccessfulFinishedAt(): Promise<Date | null> {
      const [row] = await db
        .select({ finishedAt: crawlRuns.finishedAt })
        .from(crawlRuns)
        .where(and(eq(crawlRuns.status, "completed"), isNotNull(crawlRuns.finishedAt)))
        .orderBy(desc(crawlRuns.finishedAt))
        .limit(1);
      return row?.finishedAt ?? null;
    },

    // GLOBAL-BY-DECISION: `crawl_runs`/`postings` are system-owned (no
    // userId) — the live fill strip (arch §7.2 note): postingsSeenThisRun/
    // sourcesWrittenThisRun are read live off `postings` (WAL lets this read
    // while the crawler writes), never off crawl_runs.stats — that column
    // stays null until the run finishes.
    async getRunningCrawl(nowMs: number): Promise<RunningCrawlAgg | null> {
      const [run] = await db
        .select({ startedAt: crawlRuns.startedAt })
        .from(crawlRuns)
        .where(and(eq(crawlRuns.status, "running"), gte(crawlRuns.startedAt, new Date(nowMs - LEASE_MS))))
        .orderBy(desc(crawlRuns.startedAt))
        .limit(1);
      if (!run) return null;
      const [agg] = await db
        .select({
          postingsSeenThisRun: sql<string>`count(*)`,
          sourcesWrittenThisRun: sql<string>`count(distinct ${postings.sourceId})`,
        })
        .from(postings)
        .where(gte(postings.lastSeenAt, run.startedAt));
      return {
        startedAt: run.startedAt,
        postingsSeenThisRun: Number(agg?.postingsSeenThisRun ?? 0),
        sourcesWrittenThisRun: Number(agg?.sourcesWrittenThisRun ?? 0),
      };
    },

    // GLOBAL-BY-DECISION: `crawl_runs` is system-owned (no userId) — the
    // admin last-runs health table. Newest ≤`limit` finished (non-`running`)
    // runs, newest first.
    async listFinishedRuns(limit: number): Promise<CrawlRunRow[]> {
      return db
        .select()
        .from(crawlRuns)
        .where(ne(crawlRuns.status, "running"))
        .orderBy(desc(crawlRuns.finishedAt))
        .limit(limit);
    },

    // Bottom `limit` sources by live posting count (the no-go list), plus the
    // total source count. LEFT JOIN from `sources` (not `postings`) so a
    // source with zero postings still surfaces at liveCount 0.
    async getPerSourceBottom(limit: number): Promise<{ items: PerSourceRow[]; totalSources: number }> {
      // LEFT JOIN's unmatched row has postings.id NULL too — the CASE must
      // guard on that (not just delistedAt IS NULL), or a source with zero
      // postings would wrongly count as 1 live row.
      const rows = await db
        .select({
          sourceId: sources.id,
          name: sources.name,
          liveCount: sql<string>`count(case when ${postings.id} is not null and ${postings.delistedAt} is null then 1 end)`,
          lastSeenAt: sql<string | null>`max(${postings.lastSeenAt})`,
        })
        .from(sources)
        .leftJoin(postings, eq(postings.sourceId, sources.id))
        .groupBy(sources.id)
        .orderBy(sql`count(case when ${postings.id} is not null and ${postings.delistedAt} is null then 1 end) asc`)
        .limit(limit);
      const [totalsRow] = await db.select({ total: sql<string>`count(*)` }).from(sources);
      return {
        items: rows.map((r) => ({
          sourceId: r.sourceId,
          name: r.name,
          liveCount: Number(r.liveCount),
          lastSeenAt: r.lastSeenAt != null ? new Date(Number(r.lastSeenAt)) : null,
        })),
        totalSources: Number(totalsRow.total),
      };
    },
  };
}

export const crawlRunsRepo: ReturnType<typeof createCrawlRunsRepo> = {
  getPoolCounts: () => createCrawlRunsRepo(getDb()).getPoolCounts(),
  latestSuccessfulFinishedAt: () => createCrawlRunsRepo(getDb()).latestSuccessfulFinishedAt(),
  getRunningCrawl: (nowMs) => createCrawlRunsRepo(getDb()).getRunningCrawl(nowMs),
  listFinishedRuns: (limit) => createCrawlRunsRepo(getDb()).listFinishedRuns(limit),
  getPerSourceBottom: (limit) => createCrawlRunsRepo(getDb()).getPerSourceBottom(limit),
};
