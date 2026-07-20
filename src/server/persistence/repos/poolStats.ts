// Admin Pool tab aggregate (spec 2026-07-21-admin-pool-tab-design.md §5).
// GLOBAL-BY-DECISION: postings/sources are system-owned (no userId) — same
// dimension as crawlRuns.ts's admin surfaces. Totals + source coverage are
// plain SQL count aggregates (mirrors crawlRuns.ts's getPoolCounts).
// functionMix/tzBands/freshness/concentration ride ONE light SELECT over
// live rows (title/company/functionTag/tzBand/firstSeenAt — no description,
// mirrors postings.ts's listForMatching read-amplification discipline)
// reduced in a single JS pass: spec §6 requires the hybrid function-source
// rule to live in ONE TS helper, never duplicated as SQL.
// A non-empty functionTag resolves through functionBucket.ts's
// TAG_TO_BUCKET (P.4's classifier vocabulary diverges from the 12 admin-Pool
// buckets on 6 values — a raw tag string is NOT a valid bucket id); an
// unknown non-empty tag THROWS (fail-loud, project canon: never silently
// re-bucketed or dropped) rather than vanishing from functionMix.
import { isNull, sql } from "drizzle-orm";
import { bucketFromTitle, FUNCTION_BUCKET_IDS, TAG_TO_BUCKET } from "@/server/pool/functionBucket";
import type { FunctionTag } from "@/server/sources/function";
import type { AdminPoolStats } from "@/types";
import { getDb } from "../db";
import { postings, sources } from "../schema";
import type { Db } from "./db";

const DAY_MS = 24 * 60 * 60 * 1000;

const LIVE_PROJECTION = {
  title: postings.title,
  company: postings.company,
  functionTag: postings.functionTag,
  tzBand: postings.tzBand,
  firstSeenAt: postings.firstSeenAt,
} as const;

function pct(count: number, total: number): number {
  return total === 0 ? 0 : Math.round((count / total) * 1000) / 10;
}

export function createPoolStatsRepo(db: Db) {
  return {
    // GLOBAL-BY-DECISION: `postings`/`sources` are system-owned tables (no
    // userId, same dimension as crawlRuns.ts's admin surfaces) — this is the
    // admin Pool tab's whole-pool aggregate, not a per-user resource.
    async getPoolStats(nowMs: number): Promise<AdminPoolStats> {
      const [totalsRow] = await db
        .select({
          live: sql<string>`count(case when ${postings.delistedAt} is null then 1 end)`,
          delisted: sql<string>`count(case when ${postings.delistedAt} is not null then 1 end)`,
          newLast24h: sql<string>`count(case when ${postings.delistedAt} is null and ${postings.firstSeenAt} >= ${new Date(nowMs - DAY_MS)} then 1 end)`,
          tagged: sql<string>`count(case when ${postings.delistedAt} is null and ${postings.functionTag} is not null then 1 end)`,
        })
        .from(postings);

      // Same convention as admin/sources/route.ts's `total: rows.length` and
      // crawlRuns.ts's getPerSourceBottom: counts every sources row,
      // including the `manual` pseudo-source — not re-litigated here.
      const [sourcesRow] = await db
        .select({
          total: sql<string>`count(*)`,
          enabled: sql<string>`count(case when ${sources.enabled} = 1 then 1 end)`,
        })
        .from(sources);

      const liveRows = await db.select(LIVE_PROJECTION).from(postings).where(isNull(postings.delistedAt));
      const live = Number(totalsRow.live);

      const bucketAgg = new Map<string, { count: number; tag: number; keyword: number }>();
      const tzCounts = new Map<string, number>();
      const freshCounts = new Map<"24h" | "2-7d" | "8-30d" | "older", number>();
      const companyCounts = new Map<string, number>();

      for (const row of liveRows) {
        // MINOR-1 fix: ONE non-empty check (truthy — covers both null and
        // "") drives both the bucket resolution and its provenance, so the
        // two can never disagree about whether a tag was "present".
        const tag = row.functionTag;
        let bucket: string;
        let provenance: "tag" | "keyword";
        if (tag) {
          const mapped = TAG_TO_BUCKET[tag as FunctionTag];
          if (!mapped) throw new Error(`unknown function_tag "${tag}"`);
          bucket = mapped;
          provenance = "tag";
        } else {
          bucket = bucketFromTitle(row.title);
          provenance = "keyword";
        }
        const entry = bucketAgg.get(bucket) ?? { count: 0, tag: 0, keyword: 0 };
        entry.count += 1;
        entry[provenance] += 1;
        bucketAgg.set(bucket, entry);

        const tzBand = row.tzBand ?? "unassigned";
        tzCounts.set(tzBand, (tzCounts.get(tzBand) ?? 0) + 1);

        const ageMs = nowMs - row.firstSeenAt.getTime();
        const freshBucket =
          ageMs <= DAY_MS ? "24h" : ageMs <= 7 * DAY_MS ? "2-7d" : ageMs <= 30 * DAY_MS ? "8-30d" : "older";
        freshCounts.set(freshBucket, (freshCounts.get(freshBucket) ?? 0) + 1);

        companyCounts.set(row.company, (companyCounts.get(row.company) ?? 0) + 1);
      }

      // spec §3: PoolFunctionCards renders exactly the 12 pinned buckets,
      // zero-count ones included — never just "the buckets seen in data".
      const functionMix = FUNCTION_BUCKET_IDS.map((bucket) => {
        const agg = bucketAgg.get(bucket) ?? { count: 0, tag: 0, keyword: 0 };
        return {
          bucket,
          count: agg.count,
          share: pct(agg.count, live),
          source: (agg.tag >= agg.keyword ? "tag" : "keyword") as "tag" | "keyword",
        };
      });

      const tzBands = (["americas", "emea", "apac", "unassigned"] as const).map((band) => ({
        band,
        count: tzCounts.get(band) ?? 0,
        share: pct(tzCounts.get(band) ?? 0, live),
      }));

      const freshness = (["24h", "2-7d", "8-30d", "older"] as const).map((bucket) => ({
        bucket,
        count: freshCounts.get(bucket) ?? 0,
      }));

      const topCompanies = [...companyCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([company, count]) => ({ company, count }));
      const top10Count = topCompanies.reduce((sum, c) => sum + c.count, 0);

      return {
        totals: {
          live,
          delisted: Number(totalsRow.delisted),
          newLast24h: Number(totalsRow.newLast24h),
          sourcesEnabled: Number(sourcesRow.enabled),
          sourcesTotal: Number(sourcesRow.total),
          tagCoveragePct: pct(Number(totalsRow.tagged), live),
        },
        functionMix,
        tzBands,
        freshness,
        concentration: { topCompanies, top10Count, restCount: live - top10Count },
      };
    },
  };
}

export const poolStatsRepo: ReturnType<typeof createPoolStatsRepo> = {
  getPoolStats: (nowMs) => createPoolStatsRepo(getDb()).getPoolStats(nowMs),
};
