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
import type { Job, Persona, SummaryStripStats } from "@/types";

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
  // tz_band (scheduleFlex) and hiring_structure (employmentPref) are RANK
  // signals only (DECISION A, full soft rank): they flow into listScored as
  // `rankBands`/`rankStructures`, which drive the SQL ORDER BY's misaligned
  // demotion term (out-of-band jobs sort last, CROSS-PAGE), and are never a
  // WHERE. `null` (any-hours / any, the permissive seed) means "no demotion".
  // P.5 replaced the old page-local `sortByEligibilityFit` reorder — which
  // could drop a misaligned job off the page entirely — with this single
  // cross-page SQL ordering.
  const rankBands = !isPastedScope ? allowedBandsFor(profile.scheduleFlex) : null;
  const rankStructures = !isPastedScope ? allowedStructuresFor(profile.employmentPref) : null;
  const filterScope = { ...rest, userId, isNew: isNewFilter, eligibility };

  const { items, nextCursor } = await jobsRepo.listScored({ ...filterScope, rankBands, rankStructures, cursor, limit });
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
