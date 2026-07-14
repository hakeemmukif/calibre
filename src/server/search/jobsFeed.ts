// F2 feed read model (api-contract.md §3 "GET /api/jobs") — orchestrates
// jobsRepo + searchRunsRepo (DB) and features/feed/assembleJob (pure) into
// the `{items, nextCursor, stats}` response shape. Lives in server/search
// (not features/feed, which must stay pure/no-db) because it touches the DB.
import { assembleJob } from "@/features/feed/assemble";
import type { JobsQuery } from "@/server/persistence/repos/jobs";
import { jobsRepo } from "@/server/persistence/repos/jobs";
import { profileRepo } from "@/server/persistence/repos/profile";
import { searchRunsRepo } from "@/server/persistence/repos/searchRuns";
import { hiddenBandsFor, hiddenStructuresFor } from "@/server/score/tzBand";
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
  // Pasted jobs are never isNew (spec §2.10) — no scan run exists for the
  // scope, and short-circuiting before the repo call avoids widening
  // searchRunsRepo.getLatestCompleted beyond ScanPersona.
  if (persona === "pasted") return null;
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
  // The operator pasted these deliberately — hiding a pasted `abroad` job
  // from its own scope would be absurd (spec §2.12). The tag still warns.
  const isPastedScope = query.persona === "pasted";

  // `isNew:true` with no prior completed run can't exclude anything (no
  // baseline to compare against) — falls through to "no filter" rather than
  // silently matching zero rows.
  const isNewFilter = query.isNew ? (cutoff ?? undefined) : undefined;
  const { isNew: _wireIsNew, cursor, limit, ...rest } = query;
  // relocation "stay" hides abroad; "open" applies no eligibility condition;
  // the Pasted scope applies no eligibility condition either way.
  const eligibility = !isPastedScope && profile.relocation === "stay" ? STAY_TIERS : undefined;
  // Schedule/structure gates are independent of relocation (§7) — they stay
  // active under "open" too, dropped only for the Pasted scope.
  const hiddenBands = isPastedScope ? [] : hiddenBandsFor(profile.scheduleFlex);
  const hiddenStructures = isPastedScope ? [] : hiddenStructuresFor(profile.employmentPref);
  const filterScope = { ...rest, isNew: isNewFilter, eligibility, hiddenBands, hiddenStructures };

  const { items, nextCursor } = await jobsRepo.listScored({ ...filterScope, cursor, limit });
  // `stats` is computed over the SAME filter scope (task-B6-brief.md: "the
  // full scoped result set"), just without cursor/limit — `sinceLast` always
  // uses the cutoff regardless of whether the caller applied the `isNew`
  // filter (redundant-but-consistent when they did).
  const base = await jobsRepo.statsForQuery(filterScope, cutoff);
  // The trust signal for what vanished (spec §7, §8): all jobs ANY of the
  // three gates hid, scored or not. 0 under the Pasted scope — nothing is
  // hidden there. Deliberately NOT spreading `rest` — tier/minScore are
  // job_scores columns and this answers "what did the predicate hide", not
  // "what would also have passed your score filters".
  const excluded = isPastedScope
    ? 0
    : await jobsRepo.countHiddenByPreferences({
        persona: rest.persona,
        q: rest.q,
        isNew: isNewFilter,
        hiddenTiers: profile.relocation === "stay" ? HIDDEN_TIERS : [],
        hiddenBands,
        hiddenStructures,
      });

  return {
    items: items.map((joined) => assembleJob(joined, { isNewCutoff: cutoff })),
    nextCursor,
    stats: { ...base, excluded },
  };
}
