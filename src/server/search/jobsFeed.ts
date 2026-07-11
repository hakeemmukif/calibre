// F2 feed read model (api-contract.md §3 "GET /api/jobs") — orchestrates
// jobsRepo + searchRunsRepo (DB) and features/feed/assembleJob (pure) into
// the `{items, nextCursor, stats}` response shape. Lives in server/search
// (not features/feed, which must stay pure/no-db) because it touches the DB.
import { assembleJob } from "@/features/feed/assemble";
import type { JobsQuery } from "@/server/persistence/repos/jobs";
import { jobsRepo } from "@/server/persistence/repos/jobs";
import { searchRunsRepo } from "@/server/persistence/repos/searchRuns";
import type { Job, Persona, SummaryStripStats } from "@/types";

export type FeedQuery = Omit<JobsQuery, "isNew"> & {
  // Wire boolean (api-contract.md §3 `isNew?`) — translated to the repo's
  // Date-cutoff `JobsQuery.isNew` inside this module using the same
  // previous-completed-run baseline `resolveIsNewCutoff` computes.
  isNew?: boolean;
};

// The shared baseline for both the wire `isNew` filter/field and the
// `stats.sinceLast` count (task-B6-brief.md): the previous COMPLETED search
// run's `finishedAt` for the query's persona (or the latest completed run of
// any persona when unscoped). `null` when no completed run exists yet.
export async function resolveIsNewCutoff(persona?: Persona): Promise<Date | null> {
  const run = await searchRunsRepo.getLatestCompleted(persona);
  return run?.finishedAt ?? null;
}

export async function listJobsFeed(
  query: FeedQuery,
): Promise<{ items: Job[]; nextCursor: string | null; stats: SummaryStripStats }> {
  const cutoff = await resolveIsNewCutoff(query.persona);

  // `isNew:true` with no prior completed run can't exclude anything (no
  // baseline to compare against) — falls through to "no filter" rather than
  // silently matching zero rows.
  const isNewFilter = query.isNew ? (cutoff ?? undefined) : undefined;
  const { isNew: _wireIsNew, cursor, limit, ...rest } = query;
  const filterScope = { ...rest, isNew: isNewFilter };

  const { items, nextCursor } = await jobsRepo.listScored({ ...filterScope, cursor, limit });
  // `stats` is computed over the SAME filter scope (task-B6-brief.md: "the
  // full scoped result set"), just without cursor/limit — `sinceLast` always
  // uses the cutoff regardless of whether the caller applied the `isNew`
  // filter (redundant-but-consistent when they did).
  const stats = await jobsRepo.statsForQuery(filterScope, cutoff);

  return {
    items: items.map((joined) => assembleJob(joined, { isNewCutoff: cutoff })),
    nextCursor,
    stats,
  };
}
