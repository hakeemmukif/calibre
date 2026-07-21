// Nightly global-postings crawler (arch 2026-07-17 §2, §7). The system — not
// the user — talks to the enabled boards, once per day (R3: ~03:00), writing
// the result into the shared `postings` pool that user scans read locally.
//
// Write shape is dictated by the libsql `file:` reality (arch §2.3, proven
// twice): NO `db.transaction` anywhere (no-db-transaction.test.ts is the
// build gate), single-row `ON CONFLICT(canonicalKey)` upserts, drained through
// ONE sequential writer queue so the longest write lock held is a single row.
// Source *fetches* run concurrently under a per-vendor-host limiter; only their
// DB writes serialize. WAL + busy_timeout=5000 (db.ts) absorbs interleave with
// live user scans — pinned by crawler.interleave.test.ts.
//
// Failure posture (arch §7.1):
//  - A failing source is recorded and skipped; the crawl continues (F1/F3).
//  - A 403/429 STOPS that vendor host for the night (legal stop-signal, arch
//    §2.2) and never routes around it; other hosts keep going.
//  - The per-source delist sweep runs ONLY after that source's fetch SUCCEEDS —
//    a network error must never mass-delist a board (F1). A fetch that
//    succeeds but yields ZERO postings also skips the sweep and logs loudly —
//    a bad slug or an empty vendor payload must not delist a whole board.
//  - Delisted rows purge (hard-delete) at 60 days; `jobs.posting_id ON DELETE
//    SET NULL` keeps the user's history intact across the purge (F8).
//  - A `crawl_runs` lease refuses to start while another run is still young
//    (F6), and records the completed/failed run as the queryable freshness fact
//    P.5's 48h-staleness SSE surface reads (F4).
//
// SEAM (NOT built here, per plan): the crawl-permission gate (robots +
// Content-Signal, ignition 4.4a) plugs into the per-source fetch loop below
// when Track-4 tenant-hosted vendors ride it. The current three ATS vendors do
// not need it, so the seam is left, not implemented.
import { and, eq, gt, isNotNull, isNull, lt } from "drizzle-orm";
import type { Db } from "../persistence/repos/db";
import type { SourceRow } from "../persistence/repos/sources";
import { crawlRuns, postings, type JobAlias } from "../persistence/schema";
import type { NewPosting } from "../persistence/repos/postings";
import { resolveTzBand } from "../score/tzBand";
import type { RawPosting, SourceConnector } from "../search/connector";
import { ConnectorHttpError } from "../search/connectors/_http";
import {
  canonicalKey,
  crossBoardKey,
  resolveCanonicalCollision,
  type SourceTier,
} from "./dedupe-global";

// arch §7.2 stats shape (mirrors schema.ts CrawlRunStats structurally — kept
// here rather than imported so the crawler owns its own write shape; a variable
// of this type is assignment-compatible with the crawl_runs.stats column).
export interface CrawlStats {
  sourcesOk: number;
  sourcesFailed: number;
  perHostBackoffs: Record<string, number>;
  upserts: number;
  delists: number;
  durationMs: number;
  // Source ids whose fetch SUCCEEDED but returned zero postings this run — a
  // visible anomaly (bad slug, empty vendor payload), never a delist signal.
  emptyFetches: string[];
}

export interface CrawlRunResult {
  // null only when the lease refused the run (no crawl_runs row was created).
  runId: string | null;
  status: "completed" | "failed" | "skipped";
  stats: CrawlStats;
  // Not persisted on crawl_runs (its stats shape is fixed by P.1) — surfaced
  // for the script's log line.
  purged: number;
  sourcesSkipped: number;
}

export interface CrawlDeps {
  db: Db;
  // The sources to crawl — the caller (crawl.ts) filters to enabled,
  // non-`dead` rows (F7 lives at the entry point, not here); tests inject
  // fakes directly.
  sources: SourceRow[];
  // Injected so tests drive fake connectors and the script passes the real
  // registry (`connectorForSource`).
  connectorFor: (source: SourceRow) => SourceConnector;
  // Vendor-host bucket key for the limiter + stop-on-429. Defaults to the
  // connector key (1:1 with the vendor host for the current 4 connectors).
  hostFor?: (source: SourceRow) => string;
  now?: () => number;
  concurrencyPerHost?: number;
  // Delisted rows older than this are hard-deleted (arch §2.5). Default 60d.
  purgeOlderThanMs?: number;
  // A running crawl_runs row younger than this blocks a new run (F6). Default 2h.
  leaseMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_CONCURRENCY_PER_HOST = 3;
const PURGE_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
const LEASE_MS = 2 * 60 * 60 * 1000; // 2 hours
const DESCRIPTION_CAP = 40_000; // arch §1.1 (D2): full JD, ≤40k cap enforced by the crawler

const HOST_BY_CONNECTOR: Record<string, string> = {
  greenhouse: "boards-api.greenhouse.io",
  lever: "api.lever.co",
  ashby: "api.ashbyhq.com",
};

function defaultHostFor(source: SourceRow): string {
  const key = (source.config as { connector?: string } | null)?.connector ?? source.id;
  return HOST_BY_CONNECTOR[key] ?? key;
}

// Only ats/board rows are crawlable (manual sources have no discover); the
// caller filters, this maps kind → the dedupe tier ordering (arch §4).
function tierFor(source: SourceRow): SourceTier {
  return source.kind === "ats" ? "ats" : "board";
}

// A 403/429 is the vendor telling us to back off — the stop-on-host trigger
// (arch §2.2). Any other error is an ordinary per-source failure.
function isBackoffStatus(err: unknown): boolean {
  return err instanceof ConnectorHttpError && (err.status === 429 || err.status === 403);
}

// {sourceId,url}-deduped union — never drops a previously-recorded alias
// (mirrors jobsRepo.mergeAliases). Cross-board sightings accumulate, they are
// not replaced on re-crawl.
function mergeAliases(existing: JobAlias[], incoming: JobAlias[]): JobAlias[] {
  const merged = new Map<string, JobAlias>();
  for (const a of [...existing, ...incoming]) merged.set(`${a.sourceId}::${a.url}`, a);
  return [...merged.values()];
}

// Per-host semaphore (mirrors validate.ts's limiter): ≤N in-flight per vendor
// host so one host's 479-board sweep stays polite and a stopped host's queued
// tasks drain fast (they short-circuit on the stopped-set check).
function createHostLimiter(maxConcurrent: number) {
  const active = new Map<string, number>();
  const waiters = new Map<string, Array<() => void>>();
  function acquire(host: string): Promise<void> {
    const inFlight = active.get(host) ?? 0;
    if (inFlight < maxConcurrent) {
      active.set(host, inFlight + 1);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const queue = waiters.get(host) ?? [];
      queue.push(resolve);
      waiters.set(host, queue);
    });
  }
  function release(host: string): void {
    const queue = waiters.get(host) ?? [];
    const next = queue.shift();
    if (next) {
      next();
      return;
    }
    active.set(host, Math.max(0, (active.get(host) ?? 1) - 1));
  }
  return async function run<T>(host: string, fn: () => Promise<T>): Promise<T> {
    await acquire(host);
    try {
      return await fn();
    } finally {
      release(host);
    }
  };
}

// Single sequential writer: every crawler DB write drains through here so no
// two crawler statements overlap (arch §2.3). A prior write's rejection does
// not skip the next (both branches run `fn`); the real result is returned to
// the caller while `tail` only chains ordering.
function createWriterQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn, fn);
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  };
}

async function drain(iter: AsyncIterable<RawPosting>): Promise<RawPosting[]> {
  const out: RawPosting[] = [];
  for await (const posting of iter) out.push(posting);
  return out;
}

interface Winner {
  posting: RawPosting;
  aliasUrls: JobAlias[];
}

// Within ONE board, collapse same-opening duplicates by crossBoardKey using
// P.2's resolveCanonicalCollision; the loser's URL becomes an alias of the
// winner. Same source → same tier, so this degrades to first-wins for exact
// duplicate listings on a board. Cross-SOURCE dedup is deliberately NOT done
// at crawl (see runCrawl's header note) — the under-merge bias (arch §4) makes
// an extra pool row the safe failure, never data loss.
function groupBoardPostings(source: SourceRow, boardPostings: RawPosting[], tier: SourceTier): Winner[] {
  const groups = new Map<string, Winner>();
  for (const posting of boardPostings) {
    const key = crossBoardKey(posting);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { posting, aliasUrls: [] });
      continue;
    }
    const resolved = resolveCanonicalCollision(
      { tier, sourceId: source.id, canonicalKey: canonicalKey(existing.posting) },
      { tier, sourceId: source.id, canonicalKey: canonicalKey(posting) },
    );
    if (resolved.canonical.canonicalKey === canonicalKey(posting)) {
      existing.aliasUrls.push({ sourceId: source.id, url: existing.posting.url });
      existing.posting = posting;
    } else {
      existing.aliasUrls.push({ sourceId: source.id, url: posting.url });
    }
  }
  return [...groups.values()];
}

// One single-row upsert keyed on canonicalKey. ON CONFLICT: bump lastSeenAt,
// clear delistedAt (re-listing flap tolerance, arch §2.5), merge (never
// replace) aliases, refresh the mutable content — but PRESERVE firstSeenAt
// (pool-level sighting) and functionTag/functionTagVersion (P.4's write-back
// cache, arch §3.3).
async function upsertPosting(db: Db, source: SourceRow, winner: Winner, nowMs: number): Promise<void> {
  const p = winner.posting;
  const ck = canonicalKey(p);
  const [existing] = await db
    .select({ aliases: postings.aliases })
    .from(postings)
    .where(eq(postings.canonicalKey, ck))
    .limit(1);
  const aliases = mergeAliases(existing?.aliases ?? [], winner.aliasUrls);
  // tzBand is profile-INdependent (resolveTzBand reads only location/JD text),
  // so it is stamped at crawl, not at admission (arch §1.1). description feeds
  // the worldwide-band JD-phrase probe (spec 2026-07-21 §2/§3), last resort
  // when location yields nothing.
  const tz = resolveTzBand({ location: p.location ?? null, description: p.description ?? null });
  const nowDate = new Date(nowMs);
  const values: NewPosting = {
    canonicalKey: ck,
    url: p.url,
    // discover() supplies no applyUrl (RawPosting has none); left null at crawl.
    sourceId: source.id,
    externalId: p.externalId ?? null,
    title: p.title,
    company: p.company,
    location: p.location ?? "", // NOT NULL; honest "" on absence, never fabricated
    salaryRaw: p.salaryRaw ?? null,
    description: p.description ? p.description.slice(0, DESCRIPTION_CAP) : null,
    postedAt: p.postedAt ? new Date(p.postedAt) : null,
    firstSeenAt: nowDate,
    lastSeenAt: nowDate,
    delistedAt: null,
    persona: source.persona,
    tzBand: tz?.band ?? null,
    department: p.department ?? null,
    aliases,
    raw: p,
  };
  await db
    .insert(postings)
    .values(values)
    .onConflictDoUpdate({
      target: postings.canonicalKey,
      set: {
        url: values.url,
        sourceId: values.sourceId,
        externalId: values.externalId,
        title: values.title,
        company: values.company,
        location: values.location,
        salaryRaw: values.salaryRaw,
        description: values.description,
        postedAt: values.postedAt,
        persona: values.persona,
        tzBand: values.tzBand,
        department: values.department,
        aliases,
        lastSeenAt: nowDate,
        delistedAt: null,
      },
    });
}

// Per-source delist sweep (arch §2.5) — ONLY called after this source's fetch
// succeeded. Rows this run did not re-see (lastSeenAt older than the run's
// start) are marked delisted; they leave stage-1 immediately (partial index)
// but survive 60 days for re-listing flap tolerance.
async function delistSweep(db: Db, sourceId: string, runStartedAt: number, nowMs: number): Promise<number> {
  const swept = await db
    .update(postings)
    .set({ delistedAt: new Date(nowMs) })
    .where(
      and(
        eq(postings.sourceId, sourceId),
        lt(postings.lastSeenAt, new Date(runStartedAt)),
        isNull(postings.delistedAt),
      ),
    )
    .returning({ id: postings.id });
  return swept.length;
}

// 60-day hard purge (arch §2.5). A single DELETE; FK `jobs.posting_id ON DELETE
// SET NULL` (db.ts keeps foreign_keys ON) detaches user rows without deleting
// them (F8).
async function purge(db: Db, cutoffMs: number): Promise<number> {
  const deleted = await db
    .delete(postings)
    .where(and(isNotNull(postings.delistedAt), lt(postings.delistedAt, new Date(cutoffMs))))
    .returning({ id: postings.id });
  return deleted.length;
}

// crawl_runs lease (F6): refuse to start while a `running` row is younger than
// the lease window; otherwise open a new running row and return its id. A
// crashed run's stale `running` row stops blocking once it ages past the lease.
async function acquireLease(db: Db, nowMs: number, leaseMs: number): Promise<string | null> {
  const [running] = await db
    .select({ id: crawlRuns.id })
    .from(crawlRuns)
    .where(and(eq(crawlRuns.status, "running"), gt(crawlRuns.startedAt, new Date(nowMs - leaseMs))))
    .limit(1);
  if (running) return null;
  const [row] = await db
    .insert(crawlRuns)
    .values({ status: "running", startedAt: new Date(nowMs) })
    .returning({ id: crawlRuns.id });
  return row.id;
}

export async function runCrawl(deps: CrawlDeps): Promise<CrawlRunResult> {
  const now = deps.now ?? (() => Date.now());
  const { db, connectorFor } = deps;
  const hostFor = deps.hostFor ?? defaultHostFor;
  const concurrency = deps.concurrencyPerHost ?? DEFAULT_CONCURRENCY_PER_HOST;
  const purgeMs = deps.purgeOlderThanMs ?? PURGE_MS;
  const leaseMs = deps.leaseMs ?? LEASE_MS;
  const signal = deps.signal;

  const runStartedAt = now();
  const stats: CrawlStats = {
    sourcesOk: 0,
    sourcesFailed: 0,
    perHostBackoffs: {},
    upserts: 0,
    delists: 0,
    durationMs: 0,
    emptyFetches: [],
  };
  let sourcesSkipped = 0;
  let purged = 0;

  const leaseId = await acquireLease(db, runStartedAt, leaseMs);
  if (!leaseId) {
    // Overlap protection: another run holds the lease. Do nothing (no row
    // created, no writes) — F6.
    return { runId: null, status: "skipped", stats, purged: 0, sourcesSkipped: deps.sources.length };
  }

  const stoppedHosts = new Set<string>();
  const limiter = createHostLimiter(concurrency);
  const write = createWriterQueue();

  async function crawlOneSource(source: SourceRow): Promise<void> {
    const host = hostFor(source);
    // A host stopped earlier this run (403/429) is never re-hit — its remaining
    // sources are skipped, left stale (never delisted, arch §2.2).
    if (stoppedHosts.has(host)) {
      sourcesSkipped += 1;
      return;
    }
    let boardPostings: RawPosting[];
    try {
      boardPostings = await drain(
        connectorFor(source).discover({
          targets: [],
          since: new Date(0),
          signal: signal ?? new AbortController().signal,
          onProgress: () => {},
        }),
      );
    } catch (err) {
      if (isBackoffStatus(err)) {
        stoppedHosts.add(host);
        stats.perHostBackoffs[host] = (stats.perHostBackoffs[host] ?? 0) + 1;
      }
      stats.sourcesFailed += 1;
      // Recorded, not thrown — a failing source must not abort the crawl (F1),
      // and a failed fetch NEVER triggers the delist sweep below.
      console.error(`crawl ${leaseId}: source "${source.id}" fetch failed:`, err);
      return;
    }

    // Fetch succeeded: writes drain through the single sequential queue. The
    // delist sweep is inside the SAME enqueued block, so it is gated on this
    // source's fetch success by construction.
    await write(async () => {
      const winners = groupBoardPostings(source, boardPostings, tierFor(source));
      for (const winner of winners) {
        await upsertPosting(db, source, winner, now());
        stats.upserts += 1;
      }
      if (boardPostings.length === 0) {
        // A zero-posting fetch is a visible anomaly (bad slug, transient empty
        // vendor payload) — NOT a signal that every live row for this source
        // just vanished from the board. Skip the sweep; record + log it loudly
        // instead of silently mass-delisting.
        stats.emptyFetches.push(source.id);
        console.warn(`crawl ${leaseId}: source "${source.id}" fetch returned 0 postings — skipping delist sweep`);
      } else {
        stats.delists += await delistSweep(db, source.id, runStartedAt, now());
      }
    });
    stats.sourcesOk += 1;
  }

  try {
    await Promise.all(deps.sources.map((source) => limiter(hostFor(source), () => crawlOneSource(source))));
    purged = await write(() => purge(db, now() - purgeMs));
    stats.durationMs = now() - runStartedAt;
    await db
      .update(crawlRuns)
      .set({ status: "completed", finishedAt: new Date(now()), stats })
      .where(eq(crawlRuns.id, leaseId));
    return { runId: leaseId, status: "completed", stats, purged, sourcesSkipped };
  } catch (err) {
    // An infrastructure failure (e.g. a DB write error) — distinct from a
    // per-source fetch failure, which crawlOneSource already absorbed. Record
    // the run as failed (fail loud) and re-throw.
    stats.durationMs = now() - runStartedAt;
    await db
      .update(crawlRuns)
      .set({ status: "failed", finishedAt: new Date(now()), stats })
      .where(eq(crawlRuns.id, leaseId));
    throw err;
  }
}
