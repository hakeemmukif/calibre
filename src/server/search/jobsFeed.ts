// F2 feed read model (api-contract.md §3 "GET /api/jobs") — orchestrates
// jobsRepo + searchRunsRepo (DB) and features/feed/assembleJob (pure) into
// the `{items, nextCursor, stats}` response shape. Lives in server/search
// (not features/feed, which must stay pure/no-db) because it touches the DB.
import { assembleJob } from "@/features/feed/assemble";
import type { JobsQuery } from "@/server/persistence/repos/jobs";
import { jobsRepo } from "@/server/persistence/repos/jobs";
import { profileRepo } from "@/server/persistence/repos/profile";
import { searchRunsRepo } from "@/server/persistence/repos/searchRuns";
import { allowedBandsFor, allowedStructuresFor } from "@/server/score/tzBand";
import { EligibilityTier } from "@/types";
import type { HiringStructure, Job, Persona, SummaryStripStats, TzBand } from "@/types";

export type FeedQuery = Omit<JobsQuery, "isNew" | "userId"> & {
  // Wire boolean (api-contract.md §3 `isNew?`) — translated to the repo's
  // Date-cutoff `JobsQuery.isNew` inside this module using the same
  // previous-completed-run baseline `resolveIsNewCutoff` computes.
  isNew?: boolean;
};

// The shared baseline for both the wire `isNew` filter/field and the
// `stats.sinceLast` count (task-B6-brief.md): the previous COMPLETED search
// run's `finishedAt` for the query's persona (or the latest completed run of
// any persona when unscoped). `null` when no completed run exists yet.
export async function resolveIsNewCutoff(userId: string, persona?: Persona): Promise<Date | null> {
  // Pasted jobs are never isNew (spec §2.10) — no scan run exists for the
  // scope, and short-circuiting before the repo call avoids widening
  // searchRunsRepo.getLatestCompleted beyond ScanPersona.
  if (persona === "pasted") return null;
  const run = await searchRunsRepo.getLatestCompleted(userId, persona);
  return run?.finishedAt ?? null;
}

// The tiers admitted under relocation "stay" (spec §8): abroad is hidden,
// unknown stays visible wearing its warn pill (operator decision §2.1).
const STAY_TIERS: EligibilityTier[] = ["anywhere", "eligible", "local", "unknown"];
// Complement derived (not hardcoded) so the predicate and the trust-count cannot drift.
const HIDDEN_TIERS: EligibilityTier[] = EligibilityTier.options.filter((t) => !STAY_TIERS.includes(t));

// The full tz_band/hiring_structure vocabularies (schema.ts enums) — used only
// to derive each gate's hidden-set complement below (2026-07-14 remote-fit spec §8).
const ALL_BANDS: TzBand[] = ["apac", "emea", "americas"];
const ALL_STRUCTURES: HiringStructure[] = ["local-entity", "eor", "contractor"];

export async function listJobsFeed(
  query: FeedQuery,
  userId: string,
): Promise<{ items: Job[]; nextCursor: string | null; stats: SummaryStripStats }> {
  const profile = await profileRepo.get(userId); // the predicate needs it — fail loud when unseeded
  const cutoff = await resolveIsNewCutoff(userId, query.persona);
  // The operator pasted these deliberately — hiding a pasted `abroad` job
  // from its own scope would be absurd (spec §2.12). The tag still warns.
  const isPastedScope = query.persona === "pasted";

  // `isNew:true` with no prior completed run can't exclude anything (no
  // baseline to compare against) — falls through to "no filter" rather than
  // silently matching zero rows.
  const isNewFilter = query.isNew ? (cutoff ?? undefined) : undefined;
  const { isNew: _wireIsNew, cursor, limit, ...rest } = query;
  // Three gates, all server-derived from the profile, none wire params; the
  // Pasted scope applies none of them either way (spec §2.12). relocation
  // "stay" hides abroad; "open" applies no eligibility condition.
  // `allowedBandsFor`/`allowedStructuresFor` return `null` for "no gate
  // condition" (e.g. any-hours/any, the permissive seed) — coerced to
  // `undefined` here so buildFilterConditions emits no condition at all,
  // never "hide everything".
  const eligibility = !isPastedScope && profile.relocation === "stay" ? STAY_TIERS : undefined;
  const tzBands = !isPastedScope ? (allowedBandsFor(profile.scheduleFlex) ?? undefined) : undefined;
  const hiringStructures = !isPastedScope ? (allowedStructuresFor(profile.employmentPref) ?? undefined) : undefined;
  const filterScope = { ...rest, userId, isNew: isNewFilter, eligibility, tzBands, hiringStructures };

  const { items, nextCursor } = await jobsRepo.listScored({ ...filterScope, cursor, limit });
  // `stats` is computed over the SAME filter scope (task-B6-brief.md: "the
  // full scoped result set"), just without cursor/limit — `sinceLast` always
  // uses the cutoff regardless of whether the caller applied the `isNew`
  // filter (redundant-but-consistent when they did).
  const base = await jobsRepo.statsForQuery(filterScope, cutoff);
  // The trust signal for what vanished (spec §8): all jobs any of the three
  // gates hid, scored or not, scoped to the caller's own jobs. Each hidden
  // set is the gate's complement — `[]` when the gate variable above is
  // `undefined` (Pasted scope, or a `null` allowed-set), which is what makes
  // the permissive seed's excluded stay 0. Deliberately NOT spreading `rest`
  // into the count query — tier/minScore are job_scores columns and this
  // answers "what did the three gates hide", not "what would also have
  // passed your score filters".
  const hiddenTiers = eligibility ? HIDDEN_TIERS : [];
  const hiddenBands = tzBands ? ALL_BANDS.filter((b) => !tzBands.includes(b)) : [];
  const hiddenStructures = hiringStructures ? ALL_STRUCTURES.filter((s) => !hiringStructures.includes(s)) : [];
  const excluded = await jobsRepo.countHidden(
    { userId, persona: rest.persona, q: rest.q, isNew: isNewFilter },
    { tiers: hiddenTiers, bands: hiddenBands, structures: hiddenStructures },
  );

  return {
    items: items.map((joined) => assembleJob(joined, { isNewCutoff: cutoff })),
    nextCursor,
    stats: { ...base, excluded },
  };
}
