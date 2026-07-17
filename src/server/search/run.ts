// F2 discovery + scoring run (system-architecture.md §4 "F2 Search+score",
// §6 decision 2 "inline async ... in-memory run registry ... hard runtime
// cap", decision 8 "cost cap"). B5 built discovery (fan out, role-fuzzy-match
// pre-filter, dedupe/alias-merge, upsert `jobs`); B6 adds scoring: top-N
// candidates -> scoreJob -> assembled `Job` streamed as the `job` SSE event
// B5 deferred, plus the `score`/`legitimacy` progress stages and
// `stats.worth`/`ghosts`.
import pLimit from "p-limit";
import type { LlmClient } from "@/lib/llm/client";
import { getLlm } from "@/lib/llm/client";
import { policyVersion } from "@/lib/llm/templates";
import { assembleJob } from "@/features/feed/assemble";
import { assertAndDebit } from "@/server/credits";
import { crawlRunsRepo } from "@/server/persistence/repos/crawlRuns";
import { jobsRepo, type JobRow } from "@/server/persistence/repos/jobs";
import { jobScoresRepo } from "@/server/persistence/repos/jobScores";
import { postingsRepo, type PostingMatchRow } from "@/server/persistence/repos/postings";
import { profileRepo, type ProfileRow } from "@/server/persistence/repos/profile";
import { resumesRepo, type ResumeRow } from "@/server/persistence/repos/resumes";
import { searchRunsRepo, type SearchRunRow } from "@/server/persistence/repos/searchRuns";
import { sourcesRepo, type SourceRow } from "@/server/persistence/repos/sources";
import { create, release, getActiveRunForPersona, type RunHandle } from "@/server/runs/registry";
import { EmptyJobDescriptionError, scoreJob } from "@/server/score";
import type { EligibilityTier, ErrorEnvelope, JobPhaseData, ScanFrame, ScanPersona, SearchRun, SourceEventData, TzBand } from "@/types";
import { toSearchRun } from "./assemble-run";
import type { RawPosting } from "./connector";
import { dedupeKeyFor } from "./dedupe";
import { parseSourceGeo } from "./geo";
import { resolveEligibility } from "@/server/score/eligibility";
import { allowedBandsFor } from "@/server/score/tzBand";
import { ensureDescription } from "./describe";
import { resolveIsNewCutoff } from "./jobsFeed";
import { deriveRoleTargets, roleFuzzyMatch } from "./roleMatch";
import { ensureFunctionTag } from "@/server/sources/function";

export const TOP_N_CANDIDATES = 30; // system-architecture.md §6 decision 8 "per-run score cap (~30 jobs)"
const SCORE_CONCURRENCY = 3; // rolling scoring pool width — each match-score call is observed at 25-60s

export class NoActiveResumeError extends Error {
  constructor(message = "No résumé exists — a search requires an active résumé to score against.") {
    super(message);
    this.name = "NoActiveResumeError";
  }
}

export class ActiveRunConflictError extends Error {
  readonly activeRunId: string;
  constructor(activeRunId: string) {
    super(`A search run (${activeRunId}) is already active for this persona.`);
    this.name = "ActiveRunConflictError";
    this.activeRunId = activeRunId;
  }
}

export class UnknownSourceIdsError extends Error {
  readonly unknownIds: string[];
  constructor(unknownIds: string[]) {
    super(`Unknown or disabled source id(s) for this persona: ${unknownIds.join(", ")}`);
    this.name = "UnknownSourceIdsError";
    this.unknownIds = unknownIds;
  }
}

// Synthetic discovery lane (P.5 cutover): the per-source connector fan-out is
// gone, but createScanFrameBuilder / the M2 Scans tab still expect a `source`
// lane, so the pool read reports as ONE lane instead of leaving the strip empty.
const POOL_LANE_ID = "pool";
const POOL_LANE_NAME = "Global postings pool";
// F4 (arch §7.1): the pool is served stale if the newest successful crawl is
// older than this — the scan SSE fail-louds a visible warning rather than
// pretending freshness.
const STALE_CRAWL_MS = 48 * 60 * 60 * 1000;

// Observed live (task-7b smoke): 25-60s per match-score call on the
// configured model (gpt-oss-120b). TOP_N (30) scored through a SCORE_CONCURRENCY
// (3)-wide rolling pool is up to ~10 pool-widths sequential, each bounded
// by its slowest job (worst case ~60s) => up to ~10 min worst case. Spend is
// already bounded by TOP_N + the optional CALIBER_DAILY_LLM_USD cap, so a
// longer wall-clock cap doesn't unbound cost — only lets slow runs finish.
const DEFAULT_HARD_RUN_TIMEOUT_MS = 10 * 60 * 1000;

export interface StartSearchInput {
  persona: ScanPersona;
  sources?: string[];
  resumeId?: string;
}

export interface StartSearchDeps {
  hardRunTimeoutMs?: number;
  llm?: LlmClient;
  dailyCapUsd?: number;
  // Rolling scoring-pool width. Default SCORE_CONCURRENCY (3). Injected by
  // tests to force strictly-sequential scoring (scoreConcurrency: 1) so the
  // per-job cap gate is deterministic.
  scoreConcurrency?: number;
  // Test-only seam: called once after scoreTopCandidates returns and before
  // the completion writes — lets tests force a deterministic mid-run crash
  // to exercise partial-fail persistence.
  afterScoring?: () => void;
}

export async function startSearch(
  userId: string,
  input: StartSearchInput,
  deps: StartSearchDeps = {},
): Promise<SearchRun> {
  const activeRunId = getActiveRunForPersona(userId, input.persona);
  if (activeRunId) throw new ActiveRunConflictError(activeRunId);

  // Reserve the persona slot synchronously, right after the check above and
  // before any `await` — closes the double-submit window: the three awaited
  // lookups below (résumé, sources, insert) used to sit between the check
  // and slot registration, so two concurrent requests could both pass the
  // check and both start a run. Released on any throw before the run row
  // exists (below); the normal completion/failure paths release it too.
  const runId = crypto.randomUUID();
  const handle = create("search", runId, userId, input.persona);

  try {
    const resumeRow = input.resumeId
      ? await resumesRepo.getById(input.resumeId, userId)
      : await resumesRepo.getActive(userId);
    if (!resumeRow) throw new NoActiveResumeError();

    // Eligibility needs the operator profile (spec §5) — a missing row aborts
    // the run before any fetch (ProfileMissingError, fail loud).
    const profile = await profileRepo.get(userId);

    const enabledSources = await sourcesRepo.listEnabledByPersona(input.persona);
    let scopedSources = enabledSources;
    if (input.sources) {
      const enabledIds = new Set(enabledSources.map((s) => s.id));
      const unknownIds = input.sources.filter((id) => !enabledIds.has(id));
      if (unknownIds.length > 0) throw new UnknownSourceIdsError(unknownIds);
      scopedSources = enabledSources.filter((s) => input.sources!.includes(s.id));
    }

    // Admission debit (membership spec §4.2): after every pre-flight throw
    // (conflict/resume/profile/sources) so a rejected start never charges,
    // before the row insert so a charged start always has its run.
    await assertAndDebit(userId, "scan", { refId: runId });

    const row = await searchRunsRepo.insert({
      userId,
      id: runId,
      resumeId: resumeRow.id,
      personas: [input.persona],
      status: "queued",
      stats: {
        scanned: 0,
        matched: 0,
        scored: 0,
        worth: 0,
        ghosts: 0,
        perSource: scopedSources.map((s) => ({ sourceId: s.id, found: 0, errors: 0 })),
        unscored: 0,
        capStopped: false,
        discoverMs: 0,
        scoreMs: 0,
        costUsd: 0,
        policyVersion: policyVersion("match-score"),
      },
    });

    void runFanOut(userId, row, scopedSources, resumeRow, input.persona, profile, handle, deps).catch((err) => {
      void failRun(userId, row.id, input.persona, handle, err);
    });

    return toSearchRun(row);
  } catch (err) {
    // No subscriber can exist yet (the id was never returned to a client) —
    // this emit's only job is to flip isTerminal so release() can evict the
    // handle from the registry Map instead of leaking it per rejected start.
    handle.emit({ event: "error", data: { error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) } } });
    release(runId, userId, input.persona);
    throw err;
  }
}

// Last-resort net: runFanOut catches every connector/DB error it can
// attribute to a source into `stats.perSource` and keeps going. A throw that
// escapes that (an unattributable DB error, or `toSearchRun`'s
// `SearchRun.parse` failing on the final row) used to only be logged — the
// row stayed 'running' forever (worse combined with a process restart,
// since nothing else ever revisits it) and no live SSE subscriber ever saw a
// terminal event. Mark the row 'failed' and emit a terminal 'error' event.
async function failRun(
  userId: string,
  runId: string,
  persona: ScanPersona,
  handle: RunHandle,
  err: unknown,
): Promise<void> {
  console.error(`search run ${runId} crashed unexpectedly:`, err);
  const message = err instanceof Error ? err.message : String(err);

  try {
    await searchRunsRepo.updateStatus(runId, "failed", { error: message, finishedAt: new Date() });
  } catch (persistErr) {
    console.error(`search run ${runId}: failed to persist 'failed' status after crash:`, persistErr);
  }

  const envelope: ErrorEnvelope = { error: { code: "INTERNAL", message } };
  handle.emit({ event: "error", data: envelope });
  release(runId, userId, persona);
}

// M2 live-view frame builder: owns the source-state + active-job Maps and
// pushes an ABSOLUTE (idempotent) frame onto the handle on every emit. The
// counts (`scored`/`doneCount`/top-N `total`) live inside scoreTopCandidates
// — a different function from runFanOut, where the source states live — so
// `pushFrame` takes counts as an argument and the builder is passed INTO
// scoreTopCandidates rather than reading cross-function locals.
type ScanFrameBuilder = {
  setSource(s: SourceEventData): void;
  setJob(j: JobPhaseData): void; // done/error self-remove from the active set
  pushFrame(counts: ScanFrame["counts"]): void;
};

function createScanFrameBuilder(handle: RunHandle): ScanFrameBuilder {
  const sources = new Map<string, SourceEventData>();
  const active = new Map<string, JobPhaseData>();
  const push = (counts: ScanFrame["counts"]) =>
    handle.setFrame({
      sources: [...sources.values()],
      activeJobs: [...active.values()].filter((j) => j.phase !== "done" && j.phase !== "error"),
      counts,
    } satisfies ScanFrame);
  return {
    setSource(s) { sources.set(s.sourceId, s); },
    setJob(j) { if (j.phase === "done" || j.phase === "error") active.delete(j.jobId); else active.set(j.jobId, j); },
    pushFrame: push,
  };
}

// P.5 CUTOVER (arch §3, §5, §6): the per-source connector fan-out is REPLACED
// by a read of the shared `postings` pool the nightly crawler (P.3) fills.
// Funnel: ~pool rows (NO description) → stage-1 role match in-process → function
// -tag write-back cache on survivors → deterministic band-demote rank → TOP_N →
// admit into per-user `jobs` → score (JD read from the posting). Everything
// per-user still happens, but over LOCAL rows — zero network for discovery.
async function runFanOut(
  userId: string,
  row: SearchRunRow,
  sources: SourceRow[],
  resumeRow: ResumeRow,
  persona: ScanPersona,
  profile: ProfileRow,
  handle: RunHandle,
  deps: StartSearchDeps,
): Promise<void> {
  const hardRunTimeoutMs = deps.hardRunTimeoutMs ?? DEFAULT_HARD_RUN_TIMEOUT_MS;

  await searchRunsRepo.updateStatus(row.id, "running");

  const hardCapTimer = setTimeout(() => handle.abort("hard runtime cap exceeded"), hardRunTimeoutMs);

  // Hoisted above the try so the partial-persist catch below can read the
  // last known values when the run crashes mid-flight. perSource is seeded with
  // every scoped source (so "sources in scope" stays meaningful); .found is the
  // per-source survivor count — there is no fetch, so .errors stays 0.
  const perSource = new Map<string, { found: number; errors: number }>(
    sources.map((s) => [s.id, { found: 0, errors: 0 }]),
  );
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  let scanned = 0;
  let matched = 0;
  let discoverMs = 0;
  let scoreMs = 0;
  let scored = 0;
  let worth = 0;
  let ghosts = 0;
  let unscored = 0;
  let costUsd = 0;
  let capStopped = false;

  const frame = createScanFrameBuilder(handle);
  // ONE synthetic discovery lane (see POOL_LANE_ID note): the fetch phase is
  // gone, but the M2 frame contract still expects a `source` lane.
  const emitPoolLane = (data: SourceEventData) => {
    frame.setSource(data);
    handle.emit({ event: "source", data });
    frame.pushFrame({ scored: 0, queued: 0, total: 0 });
  };

  try {
    // deriveRoleTargets stays INSIDE the try — a corrupted résumé throwing here
    // must reach the last-resort failRun net, not reject unhandled.
    const targets = deriveRoleTargets(resumeRow, persona);

    const discoverStartedAt = Date.now();
    handle.emit({
      event: "progress",
      data: { stage: "sources", current: 0, total: 0, label: "Reading the global postings pool…" },
    });
    emitPoolLane({ sourceId: POOL_LANE_ID, name: POOL_LANE_NAME, status: "fetching" });

    // F4: fail loud on a stale/absent pool BEFORE serving from it.
    await emitCrawlStalenessWarning(handle);

    // Discovery — REPLACED. The projection structurally omits `description`
    // (pinned by postings.query-projection.test.ts), so stage-1 never drags the
    // ~4.3 KB JD column. persona-scoped + live-only handled by the repo.
    const poolRows = await postingsRepo.listForMatching(persona);
    scanned = poolRows.length;

    // Stage-1 over the pool. UNIFORM roleFuzzyMatch across every source kind —
    // the old board-kind bypass (pre-P.5 run.ts:~320) is DROPPED: it existed
    // because a board's configured search query pre-scoped its results, but the
    // crawler fetches whole boards unscoped (targets:[]), so the pool is
    // uniformly unscoped and keeping the bypass would flood the feed with an
    // entire board's inventory. The recall risk this re-exposes (roleFuzzyMatch
    // over-rejecting all-baseline titles) is a matcher-quality concern owned by
    // the synonym table + P.4 classifier, not the cutover (plan risk table: "the
    // pool neither helps nor hurts recall, it makes misses cheaper to re-run").
    // `sourceById.has` applies the input.sources scope (and drops postings whose
    // canonical source was disabled after the crawl).
    const survivors = poolRows.filter(
      (p) => sourceById.has(p.sourceId) && targets.some((t) => roleFuzzyMatch(t, poolRowToRawPosting(p))),
    );

    // Function-tag write-back cache (arch §3.3): the first scan to surface an
    // unclassified posting resolves its tag (deterministic tiers first, LLM only
    // for the residue) and caches it back to the pool — later scans read free,
    // the crawl stays LLM-cost-free. Already-tagged rows are a no-op. A classify
    // failure is tolerated (recorded), never aborts the scan.
    for (const p of survivors) {
      await ensureFunctionTag(p, { llm: deps.llm }).catch((err) => {
        console.error(`search run ${row.id}: function-tag classify for posting ${p.id} failed:`, err);
      });
    }

    for (const p of survivors) perSource.get(p.sourceId)!.found += 1;
    matched = survivors.length;

    emitPoolLane({ sourceId: POOL_LANE_ID, name: POOL_LANE_NAME, status: "done", found: matched });
    discoverMs = Date.now() - discoverStartedAt;

    // Admit the TOP_N (relocation pre-drop + band-demote rank + slice + upsert),
    // then score them. Admission stamps postingId/tzBand/eligibility; eligibility
    // is a RANK/stamp signal here, never a gate (DECISION A).
    const admitted = await admitSurvivors(userId, survivors, sourceById, persona, profile);

    const scoreStartedAt = Date.now();
    ({ scored, worth, ghosts, unscored, capStopped, costUsd } = await scoreTopCandidates(
      userId,
      row,
      admitted,
      resumeRow,
      persona,
      profile,
      handle,
      deps,
      frame,
    ));
    scoreMs = Date.now() - scoreStartedAt;

    deps.afterScoring?.();

    const stats = {
      scanned,
      matched,
      scored,
      worth,
      ghosts,
      perSource: [...perSource.entries()].map(([sourceId, s]) => ({ sourceId, found: s.found, errors: s.errors })),
      unscored,
      capStopped,
      discoverMs,
      scoreMs,
      costUsd,
      policyVersion: policyVersion("match-score"),
    };
    await searchRunsRepo.updateStats(row.id, stats);
    const finished = await searchRunsRepo.updateStatus(row.id, "completed", { finishedAt: new Date() });

    const finalRow = finished ?? (await searchRunsRepo.getById(row.id, userId));
    if (!finalRow) throw new Error(`search_runs row ${row.id} vanished before completion could be recorded`);
    handle.emit({ event: "done", data: toSearchRun(finalRow) });
    // release() evicts the handle from the registry Map (guarded on
    // isTerminal) — must run AFTER the 'done' emit above so no SSE/GET
    // subscriber can observe a gap where the handle is gone but hasn't
    // terminal-emitted yet.
    release(row.id, userId, persona);
  } catch (err) {
    // Partial-run persistence (M1): write whatever counters accumulated before
    // the crash so the failed run isn't zeroed. results[] was appended
    // incrementally per job in scoreTopCandidates, so it already survives
    // untouched.
    try {
      await searchRunsRepo.updateStats(row.id, {
        scanned,
        matched,
        scored,
        worth,
        ghosts,
        perSource: [...perSource.entries()].map(([sourceId, s]) => ({ sourceId, found: s.found, errors: s.errors })),
        unscored,
        capStopped,
        discoverMs,
        scoreMs,
        costUsd,
        policyVersion: policyVersion("match-score"),
      });
    } catch (statsErr) {
      console.error(`search run ${row.id}: failed to persist partial stats before failRun:`, statsErr);
    }
    throw err; // re-throw to the existing startSearch .catch → failRun (status+error+emit)
  } finally {
    // The timer spans pool-read AND scoring; the finally clears it on every exit
    // path (success, or a throw that propagates to startSearch's failRun net) so
    // it never dangles to abort a run that already finished.
    clearTimeout(hardCapTimer);
  }
}

// roleFuzzyMatch takes a RawPosting but reads only `.title`; the stage-1
// projection (PostingMatchRow, no description) is adapted to that shape.
function poolRowToRawPosting(p: PostingMatchRow): RawPosting {
  return {
    sourceId: p.sourceId,
    externalId: p.externalId ?? undefined,
    url: p.url,
    title: p.title,
    company: p.company,
    location: p.location || undefined,
  };
}

// F4 (arch §7.1): a visible, fail-loud staleness warning on the scan SSE when
// the newest successful crawl is >48h old (or none is on record) — never a
// silent pretend-fresh fallback. Emitted as a `progress` event (the SSE union
// has no dedicated warning event); also logged server-side.
async function emitCrawlStalenessWarning(handle: RunHandle): Promise<void> {
  const last = await crawlRunsRepo.latestSuccessfulFinishedAt();
  const ageMs = last ? Date.now() - last.getTime() : Infinity;
  if (ageMs <= STALE_CRAWL_MS) return;
  const label = last
    ? `⚠ Pool may be stale — last successful crawl was ${Math.floor(ageMs / 3_600_000)}h ago`
    : "⚠ Pool freshness unknown — no successful crawl on record";
  console.warn(`search run staleness: ${label}`);
  handle.emit({ event: "progress", data: { stage: "sources", current: 0, total: 0, label } });
}

interface PoolCandidate {
  posting: PostingMatchRow;
  source: SourceRow;
  eligibility: { tier: EligibilityTier; evidence: string };
}

interface AdmittedCandidate {
  job: JobRow;
  source: SourceRow;
  // The linked posting's stored JD (arch §3.4: NOT copied into jobs at
  // admission — ensureDescription reads it here and persists it right before
  // scoring, keeping the downstream jobs.description consumers untouched).
  postingDescription: string | null;
}

// Admission (arch §3.4/§3.5): resolve per-user eligibility as a RANK/stamp
// signal, apply the ONLY pre-score drop (relocation-"stay" × abroad — KEPT,
// DECISION A does not cover relocation), band-demote rank, slice TOP_N, then
// upsert into the user's `jobs` (stamping postingId, and reading tz_band FROM
// the posting — NOT re-derived). Returns the admitted candidates in rank order.
async function admitSurvivors(
  userId: string,
  survivors: PostingMatchRow[],
  sourceById: Map<string, SourceRow>,
  persona: ScanPersona,
  profile: ProfileRow,
): Promise<AdmittedCandidate[]> {
  // Eligibility is pure (profile × source-kind/geo × location). connectorGeo/
  // jdFacts are absent here — the match projection carries no structured geo,
  // and no connector supplies RawPosting.geo today; the scoring path's Layer-C
  // refresh re-resolves with JD facts for the scored TOP_N.
  const candidates: PoolCandidate[] = survivors.map((posting) => {
    const source = sourceById.get(posting.sourceId)!;
    const eligibility = resolveEligibility({
      baseCountry: profile.baseCountry,
      sourceKind: source.kind,
      sourceGeo: parseSourceGeo(source),
      location: posting.location || undefined,
    });
    return { posting, source, eligibility };
  });

  // relocation "stay": provably-abroad postings never consume a scoring slot
  // (spec §5). tz_band is NOT a gate (DECISION A) — it demotes via
  // rankCandidatesForScoring below. NULL band was always aligned.
  const pool = candidates.filter((c) => !(profile.relocation === "stay" && c.eligibility.tier === "abroad"));
  const allowedBands = allowedBandsFor(profile.scheduleFlex); // null = all bands allowed
  const ranked = rankCandidatesForScoring(
    pool.map((c) => ({
      candidate: c,
      job: { postedAt: c.posting.postedAt, dedupeKey: dedupeKeyFor(c.posting.url), tzBand: c.posting.tzBand },
    })),
    allowedBands,
  );
  const top = ranked.slice(0, TOP_N_CANDIDATES).map((r) => r.candidate);

  // One batched getForScoring over the TOP_N (arch §3 step 6): full rows carry
  // the JD (`description`, read at scoring) and `raw` (jobs.raw is NOT NULL). A
  // posting purged between the pool read and here isn't returned — admit what
  // still exists.
  const fullById = new Map((await postingsRepo.getForScoring(top.map((c) => c.posting.id))).map((p) => [p.id, p]));

  const admitted: AdmittedCandidate[] = [];
  for (const c of top) {
    const full = fullById.get(c.posting.id);
    if (!full) continue;
    const job = await jobsRepo.upsertByDedupeKey({
      userId,
      // Per-user dedupeKey stays dedupeKeyFor(canonical url) (arch §4), so
      // pool-admitted re-sightings ON CONFLICT onto the user's existing row.
      dedupeKey: dedupeKeyFor(full.url),
      url: full.url,
      applyUrl: full.applyUrl ?? undefined,
      sourceId: c.source.id,
      externalId: full.externalId ?? undefined,
      title: full.title,
      location: full.location, // postings.location is NOT NULL ("" on absence)
      company: full.company,
      salaryRaw: full.salaryRaw ?? undefined,
      description: undefined, // arch §3.4 — not copied; scoring reads it from the posting
      postedAt: full.postedAt ?? undefined,
      persona,
      eligibility: c.eligibility.tier,
      eligibilityEvidence: c.eligibility.evidence,
      tzBand: full.tzBand, // READ FROM the posting (crawl-stamped, arch §1.1 — not re-derived)
      hiringStructure: null, // stated-only; set by the scoring path's Layer-C refresh
      aliases: [], // pool cross-board aliases live on the posting; jobs' start empty
      raw: full.raw,
      postingId: full.id, // P.1 FK — the delist/purge link + Stage-A diff key
    });
    admitted.push({ job, source: c.source, postingDescription: full.description });
  }
  return admitted;
}

function startOfToday(): Date {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return start;
}

// Task 1.2: the top-N slice below must be a pure function of posting content,
// never of the order `pool` arrives in — that order comes from connector
// network-race timing / groupByCollision's Map insertion order, both
// nondeterministic across runs of the same postings. No stage1Score exists
// yet (matching is boolean; a real stage-1 score arrives in a later phase),
// so postedAt desc (nulls last) + dedupeKey asc is the deterministic,
// sufficient stand-in tiebreak.
export function sortCandidatesForRanking<T extends { job: Pick<JobRow, "postedAt" | "dedupeKey"> }>(pool: T[]): T[] {
  return [...pool].sort((a, b) => {
    const aTime = a.job.postedAt ? a.job.postedAt.getTime() : -Infinity;
    const bTime = b.job.postedAt ? b.job.postedAt.getTime() : -Infinity;
    if (aTime !== bTime) return bTime - aTime;
    return a.job.dedupeKey < b.job.dedupeKey ? -1 : a.job.dedupeKey > b.job.dedupeKey ? 1 : 0;
  });
}

// DECISION A (operator, 2026-07-17, full soft rank — see
// docs/superpowers/plans/2026-07-17-global-postings-pool-build.md): a
// stated-but-out-of-band tz_band no longer drops a candidate pre-score, it
// demotes it. Aligned candidates fill the TOP_N slice first (each group
// internally ordered by `sortCandidatesForRanking`'s existing deterministic
// rule), so a misaligned candidate can still consume a scoring slot once the
// aligned pool runs out, rather than being dropped outright. Called by P.5's
// `admitSurvivors` to pick the TOP_N the scan admits + scores (the feed's
// cross-page demotion is a separate SQL ORDER BY in repos/jobs.ts). This
// scan-side rank is band-only: hiring_structure is unknown pre-score (set by
// the scoring path's Layer-C refresh), so it can only demote in the feed.
export function rankCandidatesForScoring<T extends { job: Pick<JobRow, "postedAt" | "dedupeKey" | "tzBand"> }>(
  pool: T[],
  allowedBands: TzBand[] | null,
): T[] {
  const aligned = pool.filter((c) => !allowedBands || !c.job.tzBand || allowedBands.includes(c.job.tzBand));
  const misaligned = pool.filter((c) => allowedBands && c.job.tzBand && !allowedBands.includes(c.job.tzBand));
  return [...sortCandidatesForRanking(aligned), ...sortCandidatesForRanking(misaligned)];
}

// Cost-capped scoring phase (system-architecture.md §6 decision 8): score the
// TOP_N candidates `admitSurvivors` already selected (relocation drop + band-
// demote rank + slice happened there, so the pool cutover admits exactly what
// it scores), stopping early (without crashing the run) once the daily LLM
// spend cap is hit. Emits the `job` SSE event as each job is scored, plus
// `score` / `legitimacy` progress stages.
async function scoreTopCandidates(
  userId: string,
  row: SearchRunRow,
  candidates: AdmittedCandidate[],
  resume: ResumeRow,
  persona: ScanPersona,
  profile: ProfileRow,
  handle: RunHandle,
  deps: StartSearchDeps,
  frame: ScanFrameBuilder,
): Promise<{ scored: number; worth: number; ghosts: number; unscored: number; capStopped: boolean; costUsd: number }> {
  const topCandidates = candidates;
  let scored = 0;
  let worth = 0;
  let ghosts = 0;
  let unscored = 0;
  let capStopped = false;
  let spentCost = 0;

  if (topCandidates.length === 0) return { scored, worth, ghosts, unscored, capStopped, costUsd: spentCost };

  const isNewCutoff = await resolveIsNewCutoff(userId, persona);
  // Hoisted once per run — policyVersion() reads the template file + hashes
  // it on every call; every candidate's skip-gate check needs the same
  // value, so compute it once rather than up to TOP_N_CANDIDATES times.
  const scorePolicyVersion = policyVersion("match-score");
  const llm = deps.llm ?? getLlm();
  const dailyCapUsd =
    deps.dailyCapUsd ?? (process.env.CALIBER_DAILY_LLM_USD ? Number(process.env.CALIBER_DAILY_LLM_USD) : undefined);
  let spentToday = dailyCapUsd !== undefined ? await jobScoresRepo.sumCostUsdSince(startOfToday()) : 0;

  const scoreConcurrency = deps.scoreConcurrency ?? SCORE_CONCURRENCY;

  handle.emit({
    event: "progress",
    data: { stage: "score", current: 0, total: topCandidates.length, label: `Scoring ${topCandidates.length} job(s)…` },
  });

  // Rolling concurrency pool (was task-7b batched Promise.all-per-3): up to
  // `scoreConcurrency` jobs score at once and a finished slot immediately
  // pulls the next candidate — no batch barrier idling a fast job behind its
  // slow neighbours. The daily-cap gate is checked as each slot OPENS (per
  // job): once running spend crosses the cap every not-yet-started job bails
  // WITHOUT spending; the ≤ scoreConcurrency-1 in-flight jobs still finish, so
  // overshoot is bounded by the pool width, not a full batch. `scored`/etc.
  // mutate safely because JS runs these callbacks on one thread — only the
  // awaits interleave, never the counter increments.
  const limit = pLimit(scoreConcurrency);
  let doneCount = 0;
  await Promise.all(
    topCandidates.map(({ job, source, postingDescription }) =>
      limit(async () => {
        // Hard cap already fired: stop draining the queue — a candidate whose
        // slot opens after the abort must not run ensureDescription (detail
        // fetch + DB write) or the liveness probe. NOT a $-cap, so leave
        // capStopped untouched; the run still completes via the tolerated path.
        if (handle.signal.aborted) return;
        if (dailyCapUsd !== undefined && spentToday >= dailyCapUsd) {
          // Log once, on the first job that bails — matches the old batch loop's
          // single cap-reached diagnostic (dropped in the pool rewrite).
          if (!capStopped) {
            console.error(`search run ${row.id}: daily cost cap reached; skipping remaining candidates`);
          }
          capStopped = true;
          await searchRunsRepo.appendResult(row.id, userId, {
            jobId: job.id,
            title: job.title,
            company: job.company,
            source: source.id,
            outcome: "skipped",
            reason: "dailyCap",
          });
          return;
        }
        // M2 jobPhase delta: absolute per-job state at each real sub-step
        // (fetching → readingJD → scoring → [rescoring] → done|error), each
        // emit also refreshing the frame with scoreTopCandidates' own counts
        // — the whole reason `frame` is passed in. Declared AFTER the
        // abort/cap guards so a bailed candidate never enters the active set.
        // `scored` in the frame is the SETTLED count (doneCount) — matching the
        // coarse `progress` event's `current`, so the snapshot and progress
        // hydration paths agree (successfully-scored lives in stats.scored).
        const counts = () => ({ scored: doneCount, queued: Math.max(0, topCandidates.length - doneCount), total: topCandidates.length });
        const emitPhase = (phase: JobPhaseData["phase"], extra?: Partial<JobPhaseData>) => {
          const data: JobPhaseData = { jobId: job.id, title: job.title, company: job.company, source: source.id, phase, ...extra };
          frame.setJob(data);
          handle.emit({ event: "jobPhase", data });
          frame.pushFrame(counts());
        };
        emitPhase("fetching");
        const jobStartedAt = Date.now();
        try {
          // Rescan skip gate (perf/scan-overhead): a job already scored for
          // this exact (résumé, policy version) combo needs zero LLM spend —
          // a résumé swap or policy-version bump still legitimately rescores
          // since the unique tuple has changed. Checked here, before
          // ensureDescription's detail fetch, so neither it nor scoreJob run.
          const alreadyScored = await jobScoresRepo.existsByJobResumePolicy(
            job.id,
            resume.id,
            scorePolicyVersion,
            userId,
          );
          if (alreadyScored) {
            emitPhase("done");
            await searchRunsRepo.appendResult(row.id, userId, {
              jobId: job.id,
              title: job.title,
              company: job.company,
              source: source.id,
              outcome: "skipped",
              reason: "alreadyScored",
            });
            return;
          }

          // Posting-first (arch §3 step 6): the pool's crawl-time JD is passed
          // straight in (no re-fetch); ensureDescription persists it to
          // jobs.description before scoring, so downstream consumers are intact.
          const jobToScore = await ensureDescription(job, source, postingDescription).catch((err) => {
            console.error(`search run ${row.id}: detail fetch for job ${job.id} failed:`, err);
            return job; // scoreJob will throw EmptyJobDescriptionError -> counted unscored
          });
          const scoreRow = await scoreJob({ job: jobToScore, source, profile, resume, llm, signal: handle.signal, onPhase: (p) => emitPhase(p) });
          spentToday += scoreRow.costUsd;
          spentCost += scoreRow.costUsd;
          scored += 1;
          if (scoreRow.verdict === "Apply" || scoreRow.verdict === "Consider") worth += 1;
          if (scoreRow.legitimacy.tier === "ghost") ghosts += 1;

          // Legitimacy folds into `done` with the tier; numeric fit is
          // scoreRow.score (scoreRow.fit is the jsonb FitEntry[]).
          emitPhase("done", { verdict: scoreRow.verdict, legitimacyTier: scoreRow.legitimacy.tier, fit: scoreRow.score });
          handle.emit({ event: "job", data: assembleJob({ job, score: scoreRow, source }, { isNewCutoff }) });
          await searchRunsRepo.appendResult(row.id, userId, {
            jobId: job.id,
            title: jobToScore.title,
            company: jobToScore.company,
            source: source.id,
            outcome: "scored",
            verdict: scoreRow.verdict,
            legitimacyTier: scoreRow.legitimacy.tier,
            // NB: the numeric 0-5 fit is `score`; `scoreRow.fit` is a jsonb FitEntry[].
            fit: scoreRow.score,
            scoredMs: Date.now() - jobStartedAt,
          });
        } catch (err) {
          // Either catch branch settles the job — `error` removes it from the
          // active lanes (frame.setJob deletes done/error jobs).
          emitPhase("error");
          if (err instanceof EmptyJobDescriptionError) {
            unscored += 1;
            await searchRunsRepo.appendResult(row.id, userId, {
              jobId: job.id,
              title: job.title,
              company: job.company,
              source: source.id,
              outcome: "unscored",
            });
          } else {
            // A single job's scoring failure (LLM error, malformed response,
            // or an aborted call once the hard cap fires — Task 2) is tolerated
            // exactly like a connector failure: the run keeps going.
            console.error(`search run ${row.id}: scoring job ${job.id} failed:`, err);
            await searchRunsRepo.appendResult(row.id, userId, {
              jobId: job.id,
              title: job.title,
              company: job.company,
              source: source.id,
              outcome: "error",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        } finally {
          doneCount += 1;
          // Refresh the frame's counts now that this job is counted done —
          // without this the LAST job's done/error push (doneCount not yet
          // incremented) would leave a terminal frame claiming queued: 1.
          frame.pushFrame(counts());
          handle.emit({
            event: "progress",
            data: {
              stage: "score",
              current: doneCount,
              total: topCandidates.length,
              label: `${doneCount}/${topCandidates.length} scored`,
            },
          });
        }
      }),
    ),
  );

  handle.emit({
    event: "progress",
    data: { stage: "legitimacy", current: topCandidates.length, total: topCandidates.length, label: "Legitimacy checks complete" },
  });

  return { scored, worth, ghosts, unscored, capStopped, costUsd: spentCost };
}
