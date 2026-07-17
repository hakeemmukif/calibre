// F2 feed read model (api-contract.md §3 "GET /api/jobs") — orchestrates
// jobsRepo + searchRunsRepo (DB) and features/feed/assembleJob (pure) into
// the `{items, nextCursor, stats}` response shape. Lives in server/search
// (not features/feed, which must stay pure/no-db) because it touches the DB.
import { assembleJob } from "@/features/feed/assemble";
import type { JobJoinScore, JobsQuery } from "@/server/persistence/repos/jobs";
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

// DECISION A (operator, 2026-07-17, full soft rank — see
// docs/superpowers/plans/2026-07-17-global-postings-pool-build.md): tz_band
// (scheduleFlex) and hiring_structure (employmentPref) no longer gate the
// feed — relocation/eligibility (STAY_TIERS above) is the only remaining
// hard filter. `isBandAligned`/`isStructureAligned` turn the old allowed-set
// gate into a rank predicate consumed by `sortByEligibilityFit` below.
function isBandAligned(band: TzBand | null, allowedBands: TzBand[] | null): boolean {
  return allowedBands === null || band === null || allowedBands.includes(band);
}
function isStructureAligned(structure: HiringStructure | null, allowedStructures: HiringStructure[] | null): boolean {
  return allowedStructures === null || structure === null || allowedStructures.includes(structure);
}

// Demote-not-hide: a stable reorder of an already-fetched page — aligned
// jobs first, misaligned jobs after, ties broken by the page's original
// (SQL) order rather than relying on Array.sort's engine stability. This is
// a page-local demotion, not a global fit-rank: `listScored`'s SQL ordering/
// cursor is unchanged (out of this task's file scope), so a misaligned job
// can still miss the page entirely once older aligned jobs fill it. A real
// cross-page fit-rank belongs to P.5's pool cutover, which rewrites the read
// path anyway (arch §3 step 7 currently says "Feed — unchanged").
function sortByEligibilityFit(
  items: JobJoinScore[],
  allowedBands: TzBand[] | null,
  allowedStructures: HiringStructure[] | null,
): JobJoinScore[] {
  return items
    .map((joined, index) => {
      const misaligned =
        (isBandAligned(joined.job.tzBand, allowedBands) ? 0 : 1) +
        (isStructureAligned(joined.job.hiringStructure, allowedStructures) ? 0 : 1);
      return { joined, index, misaligned };
    })
    .sort((a, b) => a.misaligned - b.misaligned || a.index - b.index)
    .map((entry) => entry.joined);
}

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
  // Relocation is the only remaining hard gate (spec §2.12 Pasted skip;
  // "stay" hides abroad, "open" applies no condition). tz_band/
  // hiring_structure are computed below as RANK signals only (DECISION A,
  // 2026-07-17 "full soft rank, hide nothing") — `allowedBandsFor`/
  // `allowedStructuresFor` still return `null` for "no gate condition"
  // (any-hours/any, the permissive seed), which `isBandAligned`/
  // `isStructureAligned` treat as "everything aligned".
  const eligibility = !isPastedScope && profile.relocation === "stay" ? STAY_TIERS : undefined;
  const allowedBands = !isPastedScope ? allowedBandsFor(profile.scheduleFlex) : null;
  const allowedStructures = !isPastedScope ? allowedStructuresFor(profile.employmentPref) : null;
  const filterScope = { ...rest, userId, isNew: isNewFilter, eligibility };

  const { items: rawItems, nextCursor } = await jobsRepo.listScored({ ...filterScope, cursor, limit });
  const items = sortByEligibilityFit(rawItems, allowedBands, allowedStructures);
  // `stats` is computed over the SAME filter scope (task-B6-brief.md: "the
  // full scoped result set"), just without cursor/limit — `sinceLast` always
  // uses the cutoff regardless of whether the caller applied the `isNew`
  // filter (redundant-but-consistent when they did).
  const base = await jobsRepo.statsForQuery(filterScope, cutoff);
  // The trust signal for what vanished (spec §8): relocation is the only
  // gate left that can hide a job — tz_band/hiring_structure rank, they
  // never hide (DECISION A) — so `excluded` counts STAY_TIERS only. `[]`
  // when `eligibility` is `undefined` (Pasted scope, or relocation "open"),
  // which is what keeps the permissive seed's excluded at 0. Deliberately
  // NOT spreading `rest` into the count query — tier/minScore are
  // job_scores columns and this answers "what did relocation hide", not
  // "what would also have passed your score filters".
  const hiddenTiers = eligibility ? HIDDEN_TIERS : [];
  const excluded = await jobsRepo.countHidden(
    { userId, persona: rest.persona, q: rest.q, isNew: isNewFilter },
    { tiers: hiddenTiers },
  );

  return {
    items: items.map((joined) => assembleJob(joined, { isNewCutoff: cutoff })),
    nextCursor,
    stats: { ...base, excluded },
  };
}
