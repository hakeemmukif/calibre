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
import { jobsRepo, type JobRow } from "@/server/persistence/repos/jobs";
import { jobScoresRepo } from "@/server/persistence/repos/jobScores";
import { profileRepo, type ProfileRow } from "@/server/persistence/repos/profile";
import { resumesRepo, type ResumeRow } from "@/server/persistence/repos/resumes";
import { searchRunsRepo, type SearchRunRow } from "@/server/persistence/repos/searchRuns";
import { sourcesRepo, type SourceRow } from "@/server/persistence/repos/sources";
import { create, release, getActiveRunForPersona, type RunHandle } from "@/server/runs/registry";
import { EmptyJobDescriptionError, scoreJob } from "@/server/score";
import type { ErrorEnvelope, JobPhaseData, ScanFrame, ScanPersona, SearchRun, SourceEventData } from "@/types";
import { toSearchRun } from "./assemble-run";
import type { RawPosting, SourceConnector } from "./connector";
import { connectorForSource } from "./connectors";
import { companySlugFor, dedupeKeyFor, resolveCanonicalCollision, roleTokensHash, secondaryKey } from "./dedupe";
import { parseSourceGeo } from "./geo";
import { resolveEligibility } from "@/server/score/eligibility";
import { allowedBandsFor, resolveTzBand } from "@/server/score/tzBand";
import { ensureDescription } from "./describe";
import { resolveIsNewCutoff } from "./jobsFeed";
import { deriveRoleTargets, roleFuzzyMatch } from "./roleMatch";

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

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_CONNECTOR_TIMEOUT_MS = 15_000;
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
  concurrency?: number;
  connectorTimeoutMs?: number;
  hardRunTimeoutMs?: number;
  connectorForSource?: (source: SourceRow) => SourceConnector;
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
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
  const connectorTimeoutMs = deps.connectorTimeoutMs ?? DEFAULT_CONNECTOR_TIMEOUT_MS;
  const hardRunTimeoutMs = deps.hardRunTimeoutMs ?? DEFAULT_HARD_RUN_TIMEOUT_MS;
  const resolveConnector = deps.connectorForSource ?? connectorForSource;

  await searchRunsRepo.updateStatus(row.id, "running");

  const hardCapTimer = setTimeout(() => handle.abort("hard runtime cap exceeded"), hardRunTimeoutMs);

  // Hoisted above the try so the partial-persist catch below can read the
  // last known values when the run crashes mid-flight.
  const perSource = new Map<string, { found: number; errors: number }>(
    sources.map((s) => [s.id, { found: 0, errors: 0 }]),
  );
  const matchedPostings: { posting: RawPosting; source: SourceRow }[] = [];
  let scanned = 0;
  let discoverMs = 0;
  let scoreMs = 0;
  let scored = 0;
  let worth = 0;
  let ghosts = 0;
  let unscored = 0;
  let costUsd = 0;
  let capStopped = false;

  const frame = createScanFrameBuilder(handle);

  try {
    const targets = deriveRoleTargets(resumeRow, persona);
    const limit = pLimit(concurrency);
    const totalSources = sources.length;
    let sourcesCompleted = 0;

    const discoverStartedAt = Date.now();
    handle.emit({
      event: "progress",
      data: { stage: "sources", current: 0, total: totalSources, label: `Scanning ${totalSources} source(s)…` },
    });

    const tasks = sources.map((source) =>
      limit(async () => {
        const connector = resolveConnector(source);
        const timeoutController = new AbortController();
        const timer = setTimeout(() => timeoutController.abort(), connectorTimeoutMs);
        const signal = AbortSignal.any([handle.signal, timeoutController.signal]);
        const stat = perSource.get(source.id)!;
        // M2 source delta: absolute state per source (fetching → done|error),
        // mirrored into the frame on every emit. Discovery-time frames carry
        // zero counts — the strip is source-focused then; the counts fill in
        // once scoring starts. Display column is sources.name (NOT NULL).
        const emitSource = (data: SourceEventData) => {
          frame.setSource(data);
          handle.emit({ event: "source", data });
          frame.pushFrame({ scored: 0, queued: 0, total: 0 });
        };
        emitSource({ sourceId: source.id, name: source.name, status: "fetching" });

        try {
          for await (const posting of connector.discover({
            targets,
            since: new Date(0),
            signal,
            onProgress: (e) =>
              handle.emit({ event: "progress", data: { stage: e.stage, current: e.current, total: e.total, label: e.label } }),
          })) {
            scanned += 1;
            stat.found += 1;
            // Board sources (JobStreet et al) are already query-scoped upstream
            // — the source's configured search query IS the role filter, so
            // re-filtering through roleFuzzyMatch double-gates and (observed
            // live) rejects nearly every all-baseline title ("Graduate Software
            // Engineer"). ATS sources dump their ENTIRE board, so they still
            // need the matcher. Mirrors the donor, where board results were
            // query-scoped at fetch time and roleFuzzyMatch belonged to the
            // per-user radar, not the scan gate.
            if (source.kind === "board" || targets.some((t) => roleFuzzyMatch(t, posting))) {
              matchedPostings.push({ posting, source });
            }
          }
          emitSource({ sourceId: source.id, name: source.name, status: "done", found: stat.found });
        } catch (err) {
          // Connector-level failure — TOLERATED (system-architecture.md §3
          // "partial failure tolerated into stats.perSource"): recorded, the
          // run continues and still completes. Not a swallowed error — it's
          // surfaced on the run's `stats.perSource[].errors`.
          stat.errors += 1;
          console.error(`search run ${row.id}: connector "${source.id}" failed:`, err);
          emitSource({ sourceId: source.id, name: source.name, status: "error", error: err instanceof Error ? err.message : String(err) });
        } finally {
          clearTimeout(timer);
          sourcesCompleted += 1;
          handle.emit({
            event: "progress",
            data: { stage: "fetch", current: sourcesCompleted, total: totalSources, label: `${sourcesCompleted}/${totalSources} source(s) done` },
          });
        }
      }),
    );

    await Promise.all(tasks);
    discoverMs = Date.now() - discoverStartedAt;

    const upsertedJobs = await upsertMatchedPostings(userId, matchedPostings, persona, profile);
    const scoreStartedAt = Date.now();
    ({ scored, worth, ghosts, unscored, capStopped, costUsd } = await scoreTopCandidates(
      userId,
      row,
      upsertedJobs,
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
      matched: matchedPostings.length,
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
        matched: matchedPostings.length,
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
    // The timer now spans discovery AND scoring; the finally clears it on
    // every exit path (success, or a throw that propagates to startSearch's
    // failRun net) so it never dangles to abort a run that already finished.
    clearTimeout(hardCapTimer);
  }
}

interface CanonicalGroup {
  canonical: RawPosting;
  canonicalSource: SourceRow;
  aliasUrls: { sourceId: string; url: string }[];
}

// Cross-source collision resolution for postings discovered WITHIN this run
// (system-architecture.md §3/§4: same company + role tokens + location →
// same opening; ATS beats board for the canonical URL, loser → alias).
// Re-sightings across DIFFERENT runs are handled by jobsRepo.upsertByDedupeKey
// itself, which merges aliases rather than replacing them.
function groupByCollision(matched: { posting: RawPosting; source: SourceRow }[]): Map<string, CanonicalGroup> {
  const groups = new Map<string, CanonicalGroup>();
  for (const { posting, source } of matched) {
    const key = secondaryKey({
      companySlug: companySlugFor(posting.company),
      roleTokensHash: roleTokensHash(posting.title),
      location: posting.location ?? "",
    });

    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { canonical: posting, canonicalSource: source, aliasUrls: [] });
      continue;
    }

    const resolved = resolveCanonicalCollision(
      { kind: existing.canonicalSource.kind, sourceId: existing.canonicalSource.id, url: existing.canonical.url },
      { kind: source.kind, sourceId: source.id, url: posting.url },
    );
    if (resolved.canonical.url === posting.url) {
      existing.aliasUrls.push({ sourceId: existing.canonicalSource.id, url: existing.canonical.url });
      existing.canonical = posting;
      existing.canonicalSource = source;
    } else {
      existing.aliasUrls.push({ sourceId: source.id, url: posting.url });
    }
  }
  return groups;
}

// Returns the upserted rows (+ each one's canonical source) so the caller can
// score them — B5 discarded these since scoring didn't exist yet.
async function upsertMatchedPostings(
  userId: string,
  matched: { posting: RawPosting; source: SourceRow }[],
  persona: ScanPersona,
  profile: ProfileRow,
): Promise<{ job: JobRow; source: SourceRow }[]> {
  const groups = groupByCollision(matched);
  const upserted: { job: JobRow; source: SourceRow }[] = [];
  for (const { canonical, canonicalSource, aliasUrls } of groups.values()) {
    // Layers A+B stamp eligibility at first sight (spec §5 write points);
    // the ON CONFLICT set stays lastSeenAt/aliases-only, so the stamp
    // freezes until the scoring path's Layer-C refresh.
    const { tier, evidence } = resolveEligibility({
      baseCountry: profile.baseCountry,
      sourceKind: canonicalSource.kind,
      sourceGeo: parseSourceGeo(canonicalSource),
      location: canonical.location,
      connectorGeo: canonical.geo,
    });
    // Ingest-time tz_band stamp (location string only — no jd_facts yet);
    // hiring_structure is never derivable from a location string, so it
    // stays null until the score path's Layer-C refresh.
    const tzIngest = resolveTzBand({ location: canonical.location });
    const job = await jobsRepo.upsertByDedupeKey({
      userId,
      dedupeKey: dedupeKeyFor(canonical.url),
      url: canonical.url,
      sourceId: canonicalSource.id,
      externalId: canonical.externalId,
      title: canonical.title,
      // A connector's location can be absent (e.g. a board listing with no
      // location field); jobs.location is NOT NULL, so absence normalizes to
      // "" rather than a fabricated value.
      location: canonical.location ?? "",
      company: canonical.company,
      salaryRaw: canonical.salaryRaw,
      description: canonical.description,
      postedAt: canonical.postedAt ? new Date(canonical.postedAt) : undefined,
      persona,
      eligibility: tier,
      eligibilityEvidence: evidence,
      tzBand: tzIngest?.band ?? null,
      hiringStructure: null,
      aliases: aliasUrls,
      raw: canonical,
    });
    upserted.push({ job, source: canonicalSource });
  }
  return upserted;
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

// Cost-capped scoring phase (system-architecture.md §6 decision 8): score the
// top-N (~30) candidates surviving the role-fuzzy-match pre-filter, stopping
// early (without crashing the run) once the daily LLM spend cap is hit. Emits
// the `job` SSE event B5 deferred as each job is scored, plus `score` /
// `legitimacy` progress stages.
async function scoreTopCandidates(
  userId: string,
  row: SearchRunRow,
  candidates: { job: JobRow; source: SourceRow }[],
  resume: ResumeRow,
  persona: ScanPersona,
  profile: ProfileRow,
  handle: RunHandle,
  deps: StartSearchDeps,
  frame: ScanFrameBuilder,
): Promise<{ scored: number; worth: number; ghosts: number; unscored: number; capStopped: boolean; costUsd: number }> {
  // relocation "stay": provably-abroad postings don't consume scoring slots
  // (spec §5 scan hardening — persisted, just not scored). Likewise a stated
  // tz_band provably outside the schedule dial (spec §6 rider) — NULL band
  // (unstated) always passes.
  const allowedBands = allowedBandsFor(profile.scheduleFlex); // null = all bands allowed
  const pool = candidates.filter((c) => {
    if (profile.relocation === "stay" && c.job.eligibility === "abroad") return false;
    if (allowedBands && c.job.tzBand && !allowedBands.includes(c.job.tzBand)) return false;
    return true;
  });
  const topCandidates = sortCandidatesForRanking(pool).slice(0, TOP_N_CANDIDATES);
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
    topCandidates.map(({ job, source }) =>
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

          const jobToScore = await ensureDescription(job, source).catch((err) => {
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
