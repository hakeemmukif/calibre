import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { crawlRuns, postings } from "../schema";
import type { Db } from "./db";
import { insertSource } from "./__fixtures__/helpers";
import { createCrawlRunsRepo } from "./crawlRuns";

let counter = 0;
async function insertPosting(db: Db, sourceId: string, overrides: Partial<typeof postings.$inferInsert> = {}) {
  counter += 1;
  const key = `ck-${counter}`;
  const [row] = await db
    .insert(postings)
    .values({
      canonicalKey: key,
      url: `https://example.com/${key}`,
      sourceId,
      title: "Senior Backend Engineer",
      company: "Example Co",
      location: "Remote",
      persona: "remote",
      aliases: [],
      raw: {},
      ...overrides,
    })
    .returning();
  return row;
}

describe("crawlRunsRepo.getPoolCounts", () => {
  it("counts live and delisted postings separately, total is the sum", async () => {
    const db = await createTestDb();
    const repo = createCrawlRunsRepo(db);
    const source = await insertSource(db);

    await insertPosting(db, source.id);
    await insertPosting(db, source.id);
    await insertPosting(db, source.id, { delistedAt: new Date() });

    const counts = await repo.getPoolCounts();
    expect(counts).toEqual({ live: 2, delisted: 1, total: 3 });
  });

  it("is all zero on an empty pool", async () => {
    const db = await createTestDb();
    const repo = createCrawlRunsRepo(db);
    expect(await repo.getPoolCounts()).toEqual({ live: 0, delisted: 0, total: 0 });
  });
});

describe("crawlRunsRepo.latestSuccessfulFinishedAt", () => {
  it("returns the newest completed run's finishedAt, ignoring running/failed rows", async () => {
    const db = await createTestDb();
    const repo = createCrawlRunsRepo(db);

    await db.insert(crawlRuns).values({
      status: "completed",
      startedAt: new Date("2026-07-10T03:00:00Z"),
      finishedAt: new Date("2026-07-10T03:10:00Z"),
      stats: { sourcesOk: 1, sourcesFailed: 0, perHostBackoffs: {}, upserts: 1, delists: 0, durationMs: 600_000, emptyFetches: [], failedSources: [] },
    });
    await db.insert(crawlRuns).values({
      status: "completed",
      startedAt: new Date("2026-07-16T03:00:00Z"),
      finishedAt: new Date("2026-07-16T03:10:00Z"),
      stats: { sourcesOk: 1, sourcesFailed: 0, perHostBackoffs: {}, upserts: 1, delists: 0, durationMs: 600_000, emptyFetches: [], failedSources: [] },
    });
    await db.insert(crawlRuns).values({ status: "running", startedAt: new Date("2026-07-17T03:00:00Z") });

    const finishedAt = await repo.latestSuccessfulFinishedAt();
    expect(finishedAt?.toISOString()).toBe("2026-07-16T03:10:00.000Z");
  });

  it("returns null when no crawl has ever completed", async () => {
    const db = await createTestDb();
    const repo = createCrawlRunsRepo(db);
    expect(await repo.latestSuccessfulFinishedAt()).toBeNull();
  });
});

describe("crawlRunsRepo.getRunningCrawl", () => {
  it("aggregates postings seen + distinct sources written since the running run's startedAt", async () => {
    const db = await createTestDb();
    const repo = createCrawlRunsRepo(db);
    const sourceA = await insertSource(db);
    const sourceB = await insertSource(db);
    const now = Date.now();
    const startedAt = new Date(now - 5 * 60 * 1000);

    await db.insert(crawlRuns).values({ status: "running", startedAt });
    // seen this run
    await insertPosting(db, sourceA.id, { lastSeenAt: new Date(now - 60_000) });
    await insertPosting(db, sourceB.id, { lastSeenAt: new Date(now - 30_000) });
    // stale — last seen before this run started, must not count
    await insertPosting(db, sourceA.id, { lastSeenAt: new Date(now - 10 * 60 * 1000) });

    const running = await repo.getRunningCrawl(now);
    expect(running).toEqual({ startedAt, postingsSeenThisRun: 2, sourcesWrittenThisRun: 2 });
  });

  it("is null when no run is running", async () => {
    const db = await createTestDb();
    const repo = createCrawlRunsRepo(db);
    expect(await repo.getRunningCrawl(Date.now())).toBeNull();
  });

  it("is null when the only running row is older than the 2h lease (crashed/orphaned run)", async () => {
    const db = await createTestDb();
    const repo = createCrawlRunsRepo(db);
    const now = Date.now();
    await db.insert(crawlRuns).values({ status: "running", startedAt: new Date(now - 3 * 60 * 60 * 1000) });

    expect(await repo.getRunningCrawl(now)).toBeNull();
  });
});

describe("crawlRunsRepo.listFinishedRuns", () => {
  it("returns only non-running rows, newest first, limited", async () => {
    const db = await createTestDb();
    const repo = createCrawlRunsRepo(db);
    const stats = { sourcesOk: 1, sourcesFailed: 0, perHostBackoffs: {}, upserts: 1, delists: 0, durationMs: 1000, emptyFetches: [], failedSources: [] };

    await db.insert(crawlRuns).values({ status: "completed", startedAt: new Date("2026-07-14T03:00:00Z"), finishedAt: new Date("2026-07-14T03:10:00Z"), stats });
    await db.insert(crawlRuns).values({ status: "failed", startedAt: new Date("2026-07-15T03:00:00Z"), finishedAt: new Date("2026-07-15T03:05:00Z"), stats });
    await db.insert(crawlRuns).values({ status: "completed", startedAt: new Date("2026-07-16T03:00:00Z"), finishedAt: new Date("2026-07-16T03:10:00Z"), stats });
    await db.insert(crawlRuns).values({ status: "running", startedAt: new Date("2026-07-17T03:00:00Z") });

    const rows = await repo.listFinishedRuns(2);
    expect(rows.map((r) => r.status)).toEqual(["completed", "failed"]);
    expect(rows[0].finishedAt?.toISOString()).toBe("2026-07-16T03:10:00.000Z");
  });
});

describe("crawlRunsRepo.getPerSourceBottom", () => {
  it("ranks by live posting count ascending, includes zero-posting sources, and totals all sources", async () => {
    const db = await createTestDb();
    const repo = createCrawlRunsRepo(db);
    const empty = await insertSource(db, { name: "Empty Co" });
    const one = await insertSource(db, { name: "One Co" });
    const two = await insertSource(db, { name: "Two Co" });

    await insertPosting(db, one.id, { lastSeenAt: new Date("2026-07-16T00:00:00Z") });
    await insertPosting(db, two.id, { lastSeenAt: new Date("2026-07-16T00:00:00Z") });
    await insertPosting(db, two.id, { lastSeenAt: new Date("2026-07-17T00:00:00Z") });
    // a delisted row must not count toward liveCount but its source still appears
    await insertPosting(db, one.id, { delistedAt: new Date(), lastSeenAt: new Date("2026-07-10T00:00:00Z") });

    const { items, totalSources } = await repo.getPerSourceBottom(10);
    expect(totalSources).toBe(3);
    expect(items.map((r) => r.sourceId)).toEqual([empty.id, one.id, two.id]);
    expect(items.map((r) => r.liveCount)).toEqual([0, 1, 2]);
    expect(items.find((r) => r.sourceId === empty.id)?.lastSeenAt).toBeNull();
    expect(items.find((r) => r.sourceId === two.id)?.lastSeenAt?.toISOString()).toBe("2026-07-17T00:00:00.000Z");
  });

  it("limits to the requested count", async () => {
    const db = await createTestDb();
    const repo = createCrawlRunsRepo(db);
    await insertSource(db);
    await insertSource(db);
    await insertSource(db);

    const { items } = await repo.getPerSourceBottom(2);
    expect(items).toHaveLength(2);
  });
});
