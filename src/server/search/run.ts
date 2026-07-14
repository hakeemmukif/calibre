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
import { assembleJob } from "@/features/feed/assemble";
import { jobsRepo, type JobRow } from "@/server/persistence/repos/jobs";
import { jobScoresRepo } from "@/server/persistence/repos/jobScores";
import { profileRepo, type ProfileRow } from "@/server/persistence/repos/profile";
import { resumesRepo, type ResumeRow } from "@/server/persistence/repos/resumes";
import { searchRunsRepo, type SearchRunRow } from "@/server/persistence/repos/searchRuns";
import { sourcesRepo, type SourceRow } from "@/server/persistence/repos/sources";
import { create, release, getActiveRunForPersona, type RunHandle } from "@/server/runs/registry";
import { EmptyJobDescriptionError, scoreJob } from "@/server/score";
import type { ErrorEnvelope, ScanPersona, SearchRun } from "@/types";
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

const TOP_N_CANDIDATES = 30; // system-architecture.md §6 decision 8 "per-run score cap (~30 jobs)"
const SCORE_BATCH_SIZE = 3; // observed 25-60s/match-score call — batched concurrency keeps a 30-job run inside the hard cap

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
// configured model (gpt-oss-120b). TOP_N (30) scored in SCORE_BATCH_SIZE (3)
// batches of concurrent calls is up to ~10 batches sequential, each bounded
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
      },
    });

    void runFanOut(userId, row, scopedSources, resumeRow, input.persona, profile, handle, deps).catch((err) => {
      void failRun(userId, row.id, input.persona, handle, err);
    });

    return toSearchRun(row);
  } catch (err) {
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

  const targets = deriveRoleTargets(resumeRow, persona);
  const limit = pLimit(concurrency);
  const totalSources = sources.length;

  const perSource = new Map<string, { found: number; errors: number }>(
    sources.map((s) => [s.id, { found: 0, errors: 0 }]),
  );
  const matchedPostings: { posting: RawPosting; source: SourceRow }[] = [];
  let scanned = 0;
  let sourcesCompleted = 0;

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
      } catch (err) {
        // Connector-level failure — TOLERATED (system-architecture.md §3
        // "partial failure tolerated into stats.perSource"): recorded, the
        // run continues and still completes. Not a swallowed error — it's
        // surfaced on the run's `stats.perSource[].errors`.
        stat.errors += 1;
        console.error(`search run ${row.id}: connector "${source.id}" failed:`, err);
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
  clearTimeout(hardCapTimer);

  const upsertedJobs = await upsertMatchedPostings(userId, matchedPostings, persona, profile);
  const { scored, worth, ghosts, unscored, capStopped } = await scoreTopCandidates(
    userId,
    row,
    upsertedJobs,
    resumeRow,
    persona,
    profile,
    handle,
    deps,
  );

  const stats = {
    scanned,
    matched: matchedPostings.length,
    scored,
    worth,
    ghosts,
    perSource: [...perSource.entries()].map(([sourceId, s]) => ({ sourceId, found: s.found, errors: s.errors })),
    unscored,
    capStopped,
  };
  await searchRunsRepo.updateStats(row.id, stats);
  const finished = await searchRunsRepo.updateStatus(row.id, "completed", { finishedAt: new Date() });

  release(row.id, userId, persona);
  const finalRow = finished ?? (await searchRunsRepo.getById(row.id, userId));
  if (!finalRow) throw new Error(`search_runs row ${row.id} vanished before completion could be recorded`);
  handle.emit({ event: "done", data: toSearchRun(finalRow) });
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
): Promise<{ scored: number; worth: number; ghosts: number; unscored: number; capStopped: boolean }> {
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
  const topCandidates = pool.slice(0, TOP_N_CANDIDATES);
  let scored = 0;
  let worth = 0;
  let ghosts = 0;
  let unscored = 0;
  let capStopped = false;

  if (topCandidates.length === 0) return { scored, worth, ghosts, unscored, capStopped };

  const isNewCutoff = await resolveIsNewCutoff(userId, persona);
  const llm = deps.llm ?? getLlm();
  const dailyCapUsd =
    deps.dailyCapUsd ?? (process.env.CALIBER_DAILY_LLM_USD ? Number(process.env.CALIBER_DAILY_LLM_USD) : undefined);
  let spentToday = dailyCapUsd !== undefined ? await jobScoresRepo.sumCostUsdSince(startOfToday()) : 0;

  handle.emit({
    event: "progress",
    data: { stage: "score", current: 0, total: topCandidates.length, label: `Scoring ${topCandidates.length} job(s)…` },
  });

  // Batched concurrency (task-7b): each job's match-score call is observed at
  // 25-60s, so scoring TOP_N_CANDIDATES sequentially cannot fit the hard run
  // cap. Batches of SCORE_BATCH_SIZE run via Promise.all, preserving the
  // per-job try/catch semantics below. Two deliberate trade-offs vs. the old
  // per-job loop: (1) the daily-cap check only runs BETWEEN batches (before
  // starting each one), so a batch already in flight always finishes — the
  // cap can overshoot by at most one batch's worth of spend; (2) the `job`
  // SSE event for each candidate fires as its own Promise settles, so event
  // order WITHIN a batch may interleave (acceptable — ordering across
  // batches, and progress/legitimacy framing around them, is preserved).
  let doneCount = 0;
  for (let i = 0; i < topCandidates.length; i += SCORE_BATCH_SIZE) {
    if (dailyCapUsd !== undefined && spentToday >= dailyCapUsd) {
      console.error(`search run ${row.id}: daily LLM cost cap ($${dailyCapUsd}) reached — stopping further scoring`);
      capStopped = true;
      break;
    }

    const batch = topCandidates.slice(i, i + SCORE_BATCH_SIZE);
    await Promise.all(
      batch.map(async ({ job, source }) => {
        try {
          const jobToScore = await ensureDescription(job, source).catch((err) => {
            console.error(`search run ${row.id}: detail fetch for job ${job.id} failed:`, err);
            return job; // scoreJob will throw EmptyJobDescriptionError -> counted unscored
          });
          const scoreRow = await scoreJob({ job: jobToScore, source, profile, resume, llm });
          spentToday += scoreRow.costUsd;
          scored += 1;
          if (scoreRow.verdict === "Apply" || scoreRow.verdict === "Consider") worth += 1;
          if (scoreRow.legitimacy.tier === "ghost") ghosts += 1;

          handle.emit({ event: "job", data: assembleJob({ job, score: scoreRow, source }, { isNewCutoff }) });
        } catch (err) {
          if (err instanceof EmptyJobDescriptionError) {
            // Expected, not a failure — the connector has no fetchDetail, or
            // its detail fetch failed (logged above, job unchanged), leaving
            // `description` null. Recorded distinctly (stats.unscored) rather
            // than folded into the generic tolerated-failure log below.
            unscored += 1;
          } else {
            // A single job's scoring failure (LLM error, malformed response)
            // is tolerated the same way a connector failure is (B5
            // precedent) — the run keeps going rather than crashing over one
            // bad candidate.
            console.error(`search run ${row.id}: scoring job ${job.id} failed:`, err);
          }
        }
      }),
    );

    doneCount += batch.length;
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

  handle.emit({
    event: "progress",
    data: { stage: "legitimacy", current: topCandidates.length, total: topCandidates.length, label: "Legitimacy checks complete" },
  });

  return { scored, worth, ghosts, unscored, capStopped };
}
