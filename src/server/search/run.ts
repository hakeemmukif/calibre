// F2 discovery run (system-architecture.md §4 "F2 Search+score" discovery
// half, §6 decision 2 "inline async ... in-memory run registry ... hard
// runtime cap"). B5 scope only: fan out over connectors, role-fuzzy-match
// pre-filter, dedupe/alias-merge, upsert `jobs`. NO scoring, NO `job` SSE
// events — B6 adds those.
import pLimit from "p-limit";
import { jobsRepo } from "@/server/persistence/repos/jobs";
import { resumesRepo, type ResumeRow } from "@/server/persistence/repos/resumes";
import { searchRunsRepo, type SearchRunRow } from "@/server/persistence/repos/searchRuns";
import { sourcesRepo, type SourceRow } from "@/server/persistence/repos/sources";
import { create, release, getActiveRunForPersona, type RunHandle } from "@/server/runs/registry";
import type { ErrorEnvelope, Persona, SearchRun } from "@/types";
import { toSearchRun } from "./assemble-run";
import type { RawPosting, SourceConnector } from "./connector";
import { connectorForSource } from "./connectors";
import { companySlugFor, dedupeKeyFor, resolveCanonicalCollision, roleTokensHash, secondaryKey } from "./dedupe";
import { deriveRoleTargets, roleFuzzyMatch } from "./roleMatch";

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
const DEFAULT_HARD_RUN_TIMEOUT_MS = 2 * 60 * 1000;

export interface StartSearchInput {
  persona: Persona;
  sources?: string[];
  resumeId?: string;
}

export interface StartSearchDeps {
  concurrency?: number;
  connectorTimeoutMs?: number;
  hardRunTimeoutMs?: number;
  connectorForSource?: (source: SourceRow) => SourceConnector;
}

export async function startSearch(input: StartSearchInput, deps: StartSearchDeps = {}): Promise<SearchRun> {
  const activeRunId = getActiveRunForPersona(input.persona);
  if (activeRunId) throw new ActiveRunConflictError(activeRunId);

  // Reserve the persona slot synchronously, right after the check above and
  // before any `await` — closes the double-submit window: the three awaited
  // lookups below (résumé, sources, insert) used to sit between the check
  // and slot registration, so two concurrent requests could both pass the
  // check and both start a run. Released on any throw before the run row
  // exists (below); the normal completion/failure paths release it too.
  const runId = crypto.randomUUID();
  const handle = create("search", runId, input.persona);

  try {
    const resumeRow = input.resumeId ? await resumesRepo.getById(input.resumeId) : await resumesRepo.getActive();
    if (!resumeRow) throw new NoActiveResumeError();

    const enabledSources = await sourcesRepo.listEnabledByPersona(input.persona);
    let scopedSources = enabledSources;
    if (input.sources) {
      const enabledIds = new Set(enabledSources.map((s) => s.id));
      const unknownIds = input.sources.filter((id) => !enabledIds.has(id));
      if (unknownIds.length > 0) throw new UnknownSourceIdsError(unknownIds);
      scopedSources = enabledSources.filter((s) => input.sources!.includes(s.id));
    }

    const row = await searchRunsRepo.insert({
      id: runId,
      resumeId: resumeRow.id,
      personas: [input.persona],
      status: "queued",
      stats: {
        scanned: 0,
        matched: 0,
        scored: 0,
        ghosts: 0,
        perSource: scopedSources.map((s) => ({ sourceId: s.id, found: 0, errors: 0 })),
      },
    });

    void runFanOut(row, scopedSources, resumeRow, input.persona, handle, deps).catch((err) => {
      void failRun(row.id, input.persona, handle, err);
    });

    return toSearchRun(row);
  } catch (err) {
    release(runId, input.persona);
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
async function failRun(runId: string, persona: Persona, handle: RunHandle, err: unknown): Promise<void> {
  console.error(`search run ${runId} crashed unexpectedly:`, err);
  const message = err instanceof Error ? err.message : String(err);

  try {
    await searchRunsRepo.updateStatus(runId, "failed", { error: message, finishedAt: new Date() });
  } catch (persistErr) {
    console.error(`search run ${runId}: failed to persist 'failed' status after crash:`, persistErr);
  }

  const envelope: ErrorEnvelope = { error: { code: "CONFLICT", message } };
  handle.emit({ event: "error", data: envelope });
  release(runId, persona);
}

async function runFanOut(
  row: SearchRunRow,
  sources: SourceRow[],
  resumeRow: Pick<ResumeRow, "structured">,
  persona: Persona,
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
          if (targets.some((t) => roleFuzzyMatch(t, posting))) {
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

  await upsertMatchedPostings(matchedPostings, persona);

  const stats = {
    scanned,
    matched: matchedPostings.length,
    scored: 0,
    ghosts: 0,
    perSource: [...perSource.entries()].map(([sourceId, s]) => ({ sourceId, found: s.found, errors: s.errors })),
  };
  await searchRunsRepo.updateStats(row.id, stats);
  const finished = await searchRunsRepo.updateStatus(row.id, "completed", { finishedAt: new Date() });

  release(row.id, persona);
  const finalRow = finished ?? (await searchRunsRepo.getById(row.id));
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

async function upsertMatchedPostings(matched: { posting: RawPosting; source: SourceRow }[], persona: Persona): Promise<void> {
  const groups = groupByCollision(matched);
  for (const { canonical, canonicalSource, aliasUrls } of groups.values()) {
    await jobsRepo.upsertByDedupeKey({
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
      aliases: aliasUrls,
      raw: canonical,
    });
  }
}
