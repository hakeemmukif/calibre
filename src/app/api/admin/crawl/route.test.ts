import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/errors";
import { crawlRuns, postings, sources } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { AdminCrawlStatus } from "@/types";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb, poolCountsShouldThrow: false }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { requireAdmin } = vi.hoisted(() => ({ requireAdmin: vi.fn() }));
vi.mock("@/server/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/server/auth/session")>()),
  requireAdmin: () => requireAdmin(),
}));

// Only `getPoolCounts` is ever swapped out (the degrade test) — every other
// method delegates straight through to the real repo (itself reading via the
// mocked getDb() above), so this stays a thin toggle, not a re-implementation.
vi.mock("@/server/persistence/repos/crawlRuns", async (orig) => {
  const actual = await orig<typeof import("@/server/persistence/repos/crawlRuns")>();
  return {
    ...actual,
    crawlRunsRepo: {
      ...actual.crawlRunsRepo,
      getPoolCounts: (...args: Parameters<typeof actual.crawlRunsRepo.getPoolCounts>) =>
        state.poolCountsShouldThrow
          ? Promise.reject(new Error("pool query exploded"))
          : actual.crawlRunsRepo.getPoolCounts(...args),
    },
  };
});

const { GET } = await import("./route");

const STATS = {
  perHostBackoffs: {},
  emptyFetches: [] as string[],
  failedSources: [] as { id: string; error: string }[],
  archiveErrors: 0,
};

describe("GET /api/admin/crawl", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  beforeEach(() => {
    requireAdmin.mockReset();
    requireAdmin.mockResolvedValue({ id: "admin-1", email: "admin@example.com", role: "admin" });
    state.poolCountsShouldThrow = false;
  });

  afterEach(async () => {
    await state.testDb.delete(crawlRuns);
    await state.testDb.delete(postings);
    await state.testDb.delete(sources);
  });

  it("401s with UNAUTHORIZED when there is no session", async () => {
    requireAdmin.mockRejectedValue(new UnauthorizedError());
    const res = await GET();
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("403s with FORBIDDEN for a normal (non-admin) user", async () => {
    requireAdmin.mockRejectedValue(new ForbiddenError());
    const res = await GET();
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
  });

  it("200s for an admin with the empty-pool shape (nothing crawled yet)", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(AdminCrawlStatus.parse(body)).toEqual(body);
    expect(body.pool).toEqual({ live: 0, delisted: 0, total: 0 });
    expect(body.staleness).toBeNull();
    expect(body.runningCrawl).toBeNull();
    expect(body.lastRuns).toEqual([]);
    expect(body.perSource).toEqual({ items: [], totalSources: 0 });
    expect(body.errors).toEqual([]);
  });

  it("computes `skipped` as enabledCrawlable minus (ok+failed) — the 429-stopped-host case", async () => {
    // 3 enabled+crawlable sources exist right now, but the seeded run only
    // recorded 2 as ok/failed — the 3rd was silently skipped mid-run (e.g. a
    // 429 stopped that vendor host before it was ever attempted).
    await insertSource(state.testDb, { name: "A" });
    await insertSource(state.testDb, { name: "B" });
    await insertSource(state.testDb, { name: "C" });

    await state.testDb.insert(crawlRuns).values({
      status: "completed",
      startedAt: new Date("2026-07-16T03:00:00Z"),
      finishedAt: new Date("2026-07-16T03:10:00Z"),
      stats: { ...STATS, sourcesOk: 1, sourcesFailed: 1, upserts: 5, delists: 0, durationMs: 60_000 },
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lastRuns).toHaveLength(1);
    expect(body.lastRuns[0]).toMatchObject({ status: "completed", sourcesOk: 1, sourcesFailed: 1, skipped: 1 });
  });

  it("excludes disabled and manual sources from the enabledCrawlable count feeding `skipped`", async () => {
    await insertSource(state.testDb, { name: "Enabled" });
    await insertSource(state.testDb, { name: "Disabled", enabled: false });
    await insertSource(state.testDb, { id: "manual", name: "Manual URL", kind: "manual", enabled: false });

    await state.testDb.insert(crawlRuns).values({
      status: "completed",
      startedAt: new Date("2026-07-16T03:00:00Z"),
      finishedAt: new Date("2026-07-16T03:10:00Z"),
      stats: { ...STATS, sourcesOk: 1, sourcesFailed: 0, upserts: 0, delists: 0, durationMs: 1000 },
    });

    const res = await GET();
    const body = await res.json();
    // Only "Enabled" is crawlable — disabled + manual don't count, so ok(1)
    // already covers the whole crawlable set: skipped is 0, not 2.
    expect(body.lastRuns[0].skipped).toBe(0);
  });

  it("treats a pre-c9e6d17 row (stats JSON with no failedSources key) as failedSources: null, not a 500", async () => {
    await insertSource(state.testDb, { name: "A" });
    const { failedSources: _omitted, ...legacyStats } = STATS;
    await state.testDb.insert(crawlRuns).values({
      status: "completed",
      startedAt: new Date("2026-07-10T03:00:00Z"),
      finishedAt: new Date("2026-07-10T03:10:00Z"),
      stats: { ...legacyStats, sourcesOk: 1, sourcesFailed: 0, upserts: 0, delists: 0, durationMs: 1000 } as any,
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lastRuns).toHaveLength(1);
    expect(body.lastRuns[0].failedSources).toBeNull();
  });

  it("degrades: a failing `pool` sub-query nulls only that section, others still return, and errors records it", async () => {
    await insertSource(state.testDb, { name: "A" });
    await state.testDb.insert(crawlRuns).values({
      status: "completed",
      startedAt: new Date("2026-07-16T03:00:00Z"),
      finishedAt: new Date("2026-07-16T03:10:00Z"),
      stats: { ...STATS, sourcesOk: 1, sourcesFailed: 0, upserts: 0, delists: 0, durationMs: 1000 },
    });
    state.poolCountsShouldThrow = true;

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pool).toBeNull();
    expect(body.errors).toEqual(["pool: pool query exploded"]);
    // unaffected sections still populate
    expect(body.lastRuns).toHaveLength(1);
    expect(body.lastRuns[0].skipped).toBe(0);
  });
});
