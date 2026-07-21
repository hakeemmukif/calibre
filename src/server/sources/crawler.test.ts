import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createTestDb } from "../persistence/test-db";
import type { Db } from "../persistence/repos/db";
import { createJobsRepo } from "../persistence/repos/jobs";
import { insertJob, insertSource } from "../persistence/repos/__fixtures__/helpers";
import * as schema from "../persistence/schema";
import { crawlRuns, jobs, postings } from "../persistence/schema";
import { ConnectorHttpError } from "../search/connectors/_http";
import type { RawPosting, SourceConnector } from "../search/connector";
import type { SourceRow } from "../persistence/repos/sources";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";
import { runCrawl } from "./crawler";

let seq = 0;
function rawPosting(sourceId: string, overrides: Partial<RawPosting> = {}): RawPosting {
  seq += 1;
  return {
    sourceId,
    externalId: `ext-${seq}`,
    url: `https://jobs.example.com/${sourceId}/${seq}`,
    title: "Senior Backend Engineer",
    company: "acme",
    location: "Remote",
    ...overrides,
  };
}

// One connector factory driven by a per-source-id behavior table: yield a
// fixed posting list, or throw (a ConnectorHttpError with a status, or a plain
// error). Mirrors the real connectors' `discover` contract without network.
type Behavior = { postings?: RawPosting[]; throwStatus?: number; throwPlain?: boolean };
function connectorFactory(behaviors: Record<string, Behavior>): (s: SourceRow) => SourceConnector {
  return (source) => ({
    id: source.id,
    kind: source.kind,
    persona: source.persona,
    async *discover() {
      const b = behaviors[source.id];
      if (!b) return;
      if (b.throwStatus !== undefined) throw new ConnectorHttpError(`HTTP ${b.throwStatus}`, b.throwStatus);
      if (b.throwPlain) throw new Error("boom");
      for (const p of b.postings ?? []) yield p;
    },
  });
}

describe("runCrawl", () => {
  it("stamps tzBand (resolveTzBand at crawl) and department from a fixture", async () => {
    const db = await createTestDb();
    const source = await insertSource(db, { config: { connector: "ashby", geo: { scope: "restricted" } } });
    const posting = rawPosting(source.id, { location: "Berlin, Germany", department: "Engineering" });

    const result = await runCrawl({
      db,
      sources: [source],
      connectorFor: connectorFactory({ [source.id]: { postings: [posting] } }),
    });

    expect(result.status).toBe("completed");
    const [row] = await db.select().from(postings);
    expect(row.tzBand).toBe("emea"); // Berlin → emea, profile-independent
    expect(row.department).toBe("Engineering");
    expect(row.persona).toBe("remote"); // copied from the source row
    expect(result.stats.upserts).toBe(1);
  });

  it("stamps tzBand=worldwide from the description when location gives nothing (spec 2026-07-21 §3)", async () => {
    const db = await createTestDb();
    const source = await insertSource(db, { config: { connector: "ashby", geo: { scope: "restricted" } } });
    const posting = rawPosting(source.id, {
      location: "Remote",
      description: "We are fully remote and hire from anywhere in the world.",
    });

    const result = await runCrawl({
      db,
      sources: [source],
      connectorFor: connectorFactory({ [source.id]: { postings: [posting] } }),
    });

    expect(result.status).toBe("completed");
    const [row] = await db.select().from(postings);
    expect(row.tzBand).toBe("worldwide");
  });

  it("a failing source does NOT abort the crawl", async () => {
    const db = await createTestDb();
    const bad = await insertSource(db, { config: { connector: "ashby", geo: { scope: "restricted" } } });
    const good = await insertSource(db, { config: { connector: "lever", geo: { scope: "restricted" } } });
    const goodPosting = rawPosting(good.id);

    const result = await runCrawl({
      db,
      sources: [bad, good],
      connectorFor: connectorFactory({ [bad.id]: { throwPlain: true }, [good.id]: { postings: [goodPosting] } }),
    });

    expect(result.status).toBe("completed");
    expect(result.stats.sourcesFailed).toBe(1);
    expect(result.stats.sourcesOk).toBe(1);
    const rows = await db.select().from(postings);
    expect(rows.map((r) => r.sourceId)).toEqual([good.id]);
  });

  it("delists ONLY after the source's own fetch succeeds", async () => {
    const db = await createTestDb();
    const okSource = await insertSource(db, { config: { connector: "ashby", geo: { scope: "restricted" } } });
    const failSource = await insertSource(db, { config: { connector: "lever", geo: { scope: "restricted" } } });

    // Two pre-existing rows the crawl will NOT re-see (lastSeenAt in the past).
    const stale = new Date(1000);
    const [okStale] = await db
      .insert(postings)
      .values({
        canonicalKey: "ok-stale",
        url: "https://jobs.example.com/ok/old",
        sourceId: okSource.id,
        title: "Old Role",
        company: "acme",
        location: "Remote",
        persona: "remote",
        firstSeenAt: stale,
        lastSeenAt: stale,
        aliases: [],
        raw: {},
      })
      .returning();
    const [failStale] = await db
      .insert(postings)
      .values({
        canonicalKey: "fail-stale",
        url: "https://jobs.example.com/fail/old",
        sourceId: failSource.id,
        title: "Old Role",
        company: "acme",
        location: "Remote",
        persona: "remote",
        firstSeenAt: stale,
        lastSeenAt: stale,
        aliases: [],
        raw: {},
      })
      .returning();

    await runCrawl({
      db,
      sources: [okSource, failSource],
      connectorFor: connectorFactory({
        // okSource fetches fine but returns a DIFFERENT posting → the stale row
        // is unseen this run → swept.
        [okSource.id]: { postings: [rawPosting(okSource.id)] },
        // failSource's fetch throws → its stale row must NOT be swept.
        [failSource.id]: { throwPlain: true },
      }),
    });

    const [okRow] = await db.select().from(postings).where(eq(postings.id, okStale.id));
    const [failRow] = await db.select().from(postings).where(eq(postings.id, failStale.id));
    expect(okRow.delistedAt).not.toBeNull(); // swept — fetch succeeded
    expect(failRow.delistedAt).toBeNull(); // NOT swept — fetch failed
  });

  it("a fetch that SUCCEEDS but yields zero postings does NOT delist — guards against mass-delist", async () => {
    const db = await createTestDb();
    const source = await insertSource(db, { config: { connector: "ashby", geo: { scope: "restricted" } } });
    const stale = new Date(1000);
    const [staleRow] = await db
      .insert(postings)
      .values({
        canonicalKey: "empty-fetch-stale",
        url: "https://jobs.example.com/empty/old",
        sourceId: source.id,
        title: "Old Role",
        company: "acme",
        location: "Remote",
        persona: "remote",
        firstSeenAt: stale,
        lastSeenAt: stale,
        aliases: [],
        raw: {},
      })
      .returning();

    const result = await runCrawl({
      db,
      sources: [source],
      // The fetch succeeds (no throw) but returns an empty set — a bad slug
      // or a transient empty vendor payload, not a real delist-everything.
      connectorFor: connectorFactory({ [source.id]: { postings: [] } }),
    });

    expect(result.status).toBe("completed");
    expect(result.stats.sourcesOk).toBe(1); // the fetch itself succeeded
    const [row] = await db.select().from(postings).where(eq(postings.id, staleRow.id));
    expect(row.delistedAt).toBeNull(); // NOT swept
    expect(result.stats.emptyFetches).toEqual([source.id]); // surfaced as an anomaly, not a routine delist
  });

  it("a 429 stops one host; other hosts continue", async () => {
    const db = await createTestDb();
    // Two sources on the SAME vendor host (ashby), one on another (lever).
    const a1 = await insertSource(db, { config: { connector: "ashby", geo: { scope: "restricted" } } });
    const a2 = await insertSource(db, { config: { connector: "ashby", geo: { scope: "restricted" } } });
    const b1 = await insertSource(db, { config: { connector: "lever", geo: { scope: "restricted" } } });
    const a2Posting = rawPosting(a2.id);
    const b1Posting = rawPosting(b1.id);

    const result = await runCrawl({
      db,
      sources: [a1, a2, b1],
      // Serialize the ashby host so a1's 429 registers before a2 is attempted.
      concurrencyPerHost: 1,
      connectorFor: connectorFactory({
        [a1.id]: { throwStatus: 429 },
        [a2.id]: { postings: [a2Posting] },
        [b1.id]: { postings: [b1Posting] },
      }),
    });

    expect(result.status).toBe("completed");
    expect(result.stats.perHostBackoffs["api.ashbyhq.com"]).toBe(1);
    expect(result.stats.sourcesFailed).toBe(1); // a1
    expect(result.sourcesSkipped).toBe(1); // a2, skipped because its host stopped
    expect(result.stats.sourcesOk).toBe(1); // b1, other host continued
    const rows = await db.select().from(postings);
    expect(rows.map((r) => r.sourceId)).toEqual([b1.id]);
  });

  it("the lease prevents overlapping runs", async () => {
    const db = await createTestDb();
    const source = await insertSource(db);
    // A young 'running' row already holds the lease.
    await db.insert(crawlRuns).values({ status: "running", startedAt: new Date() });

    const result = await runCrawl({
      db,
      sources: [source],
      connectorFor: connectorFactory({ [source.id]: { postings: [rawPosting(source.id)] } }),
    });

    expect(result.status).toBe("skipped");
    expect(result.runId).toBeNull();
    expect(await db.select().from(postings)).toEqual([]); // no writes happened
  });

  it("a stale 'running' lease (older than the window) does NOT block a new run", async () => {
    const db = await createTestDb();
    const source = await insertSource(db);
    await db.insert(crawlRuns).values({ status: "running", startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000) });

    const result = await runCrawl({
      db,
      sources: [source],
      leaseMs: 2 * 60 * 60 * 1000,
      connectorFor: connectorFactory({ [source.id]: { postings: [rawPosting(source.id)] } }),
    });

    expect(result.status).toBe("completed");
    expect((await db.select().from(postings)).length).toBe(1);
  });

  it("60-day purge hard-deletes the posting AND jobs.posting_id SET NULL keeps the user row", async () => {
    const db = await createTestDb();
    const source = await insertSource(db);
    const day = 24 * 60 * 60 * 1000;
    const [old] = await db
      .insert(postings)
      .values({
        canonicalKey: "purge-me",
        url: "https://jobs.example.com/purge",
        sourceId: source.id,
        title: "Gone",
        company: "acme",
        location: "Remote",
        persona: "remote",
        delistedAt: new Date(Date.now() - 61 * day), // delisted > 60d ago
        aliases: [],
        raw: {},
      })
      .returning();
    const job = await insertJob(db, source.id, { postingId: old.id });
    expect(job.postingId).toBe(old.id);

    const result = await runCrawl({ db, sources: [], connectorFor: connectorFactory({}) });

    expect(result.purged).toBe(1);
    expect(await db.select().from(postings).where(eq(postings.id, old.id))).toEqual([]); // hard-deleted
    const [survivor] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(survivor).toBeDefined(); // user row intact
    expect(survivor.postingId).toBeNull(); // detached, not cascaded
  });

  it("re-crawl bumps lastSeenAt, clears delistedAt, and merges (not replaces) aliases", async () => {
    const db = await createTestDb();
    const source = await insertSource(db, { config: { connector: "ashby", geo: { scope: "restricted" } } });
    const posting = rawPosting(source.id, { externalId: "stable-1" });

    const first = await runCrawl({
      db,
      sources: [source],
      connectorFor: connectorFactory({ [source.id]: { postings: [posting] } }),
    });
    expect(first.stats.upserts).toBe(1);
    const [afterFirst] = await db.select().from(postings);
    const firstSeen = afterFirst.firstSeenAt;

    // Manually delist + seed an alias, then re-crawl the same posting.
    await db
      .update(postings)
      .set({ delistedAt: new Date(), aliases: [{ sourceId: "board-x", url: "https://board-x/1" }] })
      .where(eq(postings.id, afterFirst.id));

    // Fresh lease window (the first run's crawl_runs row is 'completed', not blocking).
    await runCrawl({
      db,
      sources: [source],
      connectorFor: connectorFactory({ [source.id]: { postings: [posting] } }),
    });

    const rows = await db.select().from(postings);
    expect(rows).toHaveLength(1); // still one canonical row
    expect(rows[0].delistedAt).toBeNull(); // re-listing cleared the delist
    expect(rows[0].firstSeenAt.getTime()).toBe(firstSeen.getTime()); // preserved
    expect(rows[0].aliases).toEqual([{ sourceId: "board-x", url: "https://board-x/1" }]); // merged, not wiped
  });
});

// ---- write-interleave: crawler writes while a user scan writes (no SQLITE_BUSY) ----
// The core libsql-shape correctness check (arch §2.3). Two connections to ONE
// WAL file: the crawler's sequential upserts drain concurrently with a scan's
// jobs upserts. WAL + busy_timeout=5000 must absorb every collision.

const migrationsDir = join(__dirname, "../../../drizzle");
const interleaveFiles: string[] = [];
afterAll(() => {
  for (const f of interleaveFiles) for (const s of ["", "-journal", "-wal", "-shm"]) rmSync(f + s, { force: true });
});

async function openWalDb(path: string): Promise<Db> {
  const client = createClient({ url: `file:${path}` });
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA busy_timeout = 5000");
  return drizzle(client, { schema }) as Db;
}

describe("runCrawl write-interleave", () => {
  it("crawler upserts and a concurrent user scan write without SQLITE_BUSY", async () => {
    const path = join(tmpdir(), `caliber-crawl-il-${randomUUID()}.db`);
    interleaveFiles.push(path);

    // Apply the committed migrations once (mirrors test-db.ts).
    const bootstrap = createClient({ url: `file:${path}` });
    for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
      await bootstrap.executeMultiple(readFileSync(join(migrationsDir, file), "utf-8"));
    }
    bootstrap.close();

    const crawlerDb = await openWalDb(path);
    const scanDb = await openWalDb(path);

    const source = await insertSource(crawlerDb, { config: { connector: "ashby", geo: { scope: "restricted" } } });
    const N = 60;
    // Distinct companies → distinct crossBoardKeys, so the board's postings do
    // not collapse into one opening (they are 60 different openings).
    const boardPostings = Array.from({ length: N }, (_, i) => rawPosting(source.id, { company: `company-${i}` }));

    const scanRepo = createJobsRepo(scanDb);
    const scanWrites = (async () => {
      for (let i = 0; i < N; i += 1) {
        await scanRepo.upsertByDedupeKey({
          userId: BOOTSTRAP_ADMIN_ID,
          dedupeKey: `scan-${i}`,
          url: `https://example.com/scan/${i}`,
          sourceId: source.id,
          title: "Scan Job",
          company: "acme",
          location: "Remote",
          persona: "remote",
          eligibility: "unknown",
          eligibilityEvidence: "interleave test",
          aliases: [],
          raw: {},
        });
      }
    })();

    const crawl = runCrawl({
      db: crawlerDb,
      sources: [source],
      connectorFor: connectorFactory({ [source.id]: { postings: boardPostings } }),
    });

    // Neither side throws SQLITE_BUSY.
    const [crawlResult] = await Promise.all([crawl, scanWrites]);

    expect(crawlResult.status).toBe("completed");
    expect(crawlResult.stats.upserts).toBe(N);
    expect((await crawlerDb.select().from(postings)).length).toBe(N);
    expect((await scanDb.select().from(jobs)).length).toBe(N);
  });
});
