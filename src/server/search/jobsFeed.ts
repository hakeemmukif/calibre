// F2 feed read model (api-contract.md §3 "GET /api/jobs") — orchestrates
// jobsRepo + searchRunsRepo (DB) and features/feed/assembleJob (pure) into
// the `{items, nextCursor, stats}` response shape. Lives in server/search
// (not features/feed, which must stay pure/no-db) because it touches the DB.
import { assembleJob } from "@/features/feed/assemble";
import type { JobsQuery } from "@/server/persistence/repos/jobs";
import { jobsRepo } from "@/server/persistence/repos/jobs";
import { profileRepo } from "@/server/persistence/repos/profile";
import { searchRunsRepo } from "@/server/persistence/repos/searchRuns";
import { EligibilityTier } from "@/types";
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

// The tiers admitted under relocation "stay" (spec §8): abroad is hidden,
// unknown stays visible wearing its warn pill (operator decision §2.1).
const STAY_TIERS: EligibilityTier[] = ["anywhere", "eligible", "local", "unknown"];
// Complement derived (not hardcoded) so the predicate and the trust-count cannot drift.
const HIDDEN_TIERS: EligibilityTier[] = EligibilityTier.options.filter((t) => !STAY_TIERS.includes(t));

export async function listJobsFeed(
  query: FeedQuery,
): Promise<{ items: Job[]; nextCursor: string | null; stats: SummaryStripStats }> {
  const profile = await profileRepo.get(); // the predicate needs it — fail loud when unseeded
  const cutoff = await resolveIsNewCutoff(query.persona);

  // `isNew:true` with no prior completed run can't exclude anything (no
  // baseline to compare against) — falls through to "no filter" rather than
  // silently matching zero rows.
  const isNewFilter = query.isNew ? (cutoff ?? undefined) : undefined;
  const { isNew: _wireIsNew, cursor, limit, ...rest } = query;
  // relocation "stay" hides abroad; "open" applies no eligibility condition.
  const eligibility = profile.relocation === "stay" ? STAY_TIERS : undefined;
  const filterScope = { ...rest, isNew: isNewFilter, eligibility };

  const { items, nextCursor } = await jobsRepo.listScored({ ...filterScope, cursor, limit });
  // `stats` is computed over the SAME filter scope (task-B6-brief.md: "the
  // full scoped result set"), just without cursor/limit — `sinceLast` always
  // uses the cutoff regardless of whether the caller applied the `isNew`
  // filter (redundant-but-consistent when they did).
  const base = await jobsRepo.statsForQuery(filterScope, cutoff);
  // The trust signal for what vanished (spec §8): all jobs the predicate hid,
  // scored or not. 0 under "open" — nothing is hidden. Deliberately NOT
  // spreading `rest` — tier/minScore are job_scores columns and this answers
  // "what did the geo predicate hide", not "what would also have passed your
  // score filters".
  const excluded =
    profile.relocation === "stay"
      ? await jobsRepo.countHiddenByEligibility({ persona: rest.persona, q: rest.q, isNew: isNewFilter, eligibility: HIDDEN_TIERS })
      : 0;

  return {
    items: items.map((joined) => assembleJob(joined, { isNewCutoff: cutoff })),
    nextCursor,
    stats: { ...base, excluded },
  };
}
