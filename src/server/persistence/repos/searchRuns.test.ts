import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { users } from "../schema";
import { insertResume } from "./__fixtures__/helpers";
import { createSearchRunsRepo } from "./searchRuns";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

const baseStatsFixture = { scanned: 0, matched: 0, scored: 0, worth: 0, ghosts: 0, perSource: [] as { sourceId: string; found: number; errors: number }[] };

describe("searchRunsRepo", () => {
  it("round-trips insert/getById and updates status + stats", async () => {
    const db = await createTestDb();
    const repo = createSearchRunsRepo(db);
    const resume = await insertResume(db);

    const inserted = await repo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      resumeId: resume.id,
      personas: ["remote"],
      status: "queued",
      stats: { scanned: 0, matched: 0, scored: 0, worth: 0, ghosts: 0, perSource: [] },
    });
    expect(inserted.status).toBe("queued");

    const running = await repo.updateStatus(inserted.id, "running");
    expect(running?.status).toBe("running");

    const withStats = await repo.updateStats(inserted.id, {
      scanned: 10,
      matched: 5,
      scored: 3,
      worth: 2,
      ghosts: 1,
      perSource: [{ sourceId: "greenhouse", found: 10, errors: 0 }],
    });
    expect(withStats?.stats.scanned).toBe(10);

    const done = await repo.updateStatus(inserted.id, "completed", { finishedAt: new Date() });
    expect(done?.status).toBe("completed");
    expect(done?.finishedAt).not.toBeNull();

    const fetched = await repo.getById(inserted.id, BOOTSTRAP_ADMIN_ID);
    expect(fetched?.id).toBe(inserted.id);
  });

  it("getById is scoped by userId — a foreign-owned run id resolves to null (no existence leak)", async () => {
    const db = await createTestDb();
    const repo = createSearchRunsRepo(db);
    const resume = await insertResume(db);
    const [userB] = await db
      .insert(users)
      .values({ email: "user-b-searchruns-getbyid@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();

    const run = await repo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      resumeId: resume.id,
      personas: ["remote"],
      status: "queued",
      stats: { scanned: 0, matched: 0, scored: 0, worth: 0, ghosts: 0, perSource: [] },
    });

    expect(await repo.getById(run.id, userB.id)).toBeNull();
    expect((await repo.getById(run.id, BOOTSTRAP_ADMIN_ID))?.id).toBe(run.id);
  });

  it("getLatestCompleted is per-user — a second user's completed runs never leak into another user's cutoff", async () => {
    const db = await createTestDb();
    const repo = createSearchRunsRepo(db);
    const resumeA = await insertResume(db);
    const [userB] = await db
      .insert(users)
      .values({ email: "user-b-searchruns@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    const resumeB = await insertResume(db, { userId: userB.id });

    const runA = await repo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      resumeId: resumeA.id,
      personas: ["remote"],
      status: "completed",
      stats: { scanned: 0, matched: 0, scored: 0, worth: 0, ghosts: 0, perSource: [] },
    });
    await repo.updateStatus(runA.id, "completed", { finishedAt: new Date("2026-01-01T00:00:00.000Z") });

    // B has no completed run at all — must read null, never A's.
    expect(await repo.getLatestCompleted(userB.id)).toBeNull();

    const runB = await repo.insert({
      userId: userB.id,
      resumeId: resumeB.id,
      personas: ["remote"],
      status: "completed",
      stats: { scanned: 0, matched: 0, scored: 0, worth: 0, ghosts: 0, perSource: [] },
    });
    await repo.updateStatus(runB.id, "completed", { finishedAt: new Date("2026-06-01T00:00:00.000Z") });

    expect((await repo.getLatestCompleted(userB.id))?.id).toBe(runB.id);
    expect((await repo.getLatestCompleted(BOOTSTRAP_ADMIN_ID))?.id).toBe(runA.id);
  });

  it("markAllUnfinishedAsFailed flips 'queued' and 'running' rows to 'failed' with an error and finishedAt, leaving completed/failed untouched", async () => {
    const db = await createTestDb();
    const repo = createSearchRunsRepo(db);
    const resume = await insertResume(db);

    const base = { userId: BOOTSTRAP_ADMIN_ID, resumeId: resume.id, personas: ["remote" as const], stats: { scanned: 0, matched: 0, scored: 0, worth: 0, ghosts: 0, perSource: [] } };
    const running = await repo.insert({ ...base, status: "running" });
    const queued = await repo.insert({ ...base, status: "queued" });
    const completed = await repo.insert({ ...base, status: "completed" });
    const alreadyFailed = await repo.insert({ ...base, status: "failed" });

    const flipped = await repo.markAllUnfinishedAsFailed("stale: process restarted while running");
    expect(flipped.map((r) => r.id).sort()).toEqual([queued.id, running.id].sort());

    expect((await repo.getById(running.id, BOOTSTRAP_ADMIN_ID))?.status).toBe("failed");
    expect((await repo.getById(running.id, BOOTSTRAP_ADMIN_ID))?.error).toBe("stale: process restarted while running");
    expect((await repo.getById(running.id, BOOTSTRAP_ADMIN_ID))?.finishedAt).not.toBeNull();
    expect((await repo.getById(queued.id, BOOTSTRAP_ADMIN_ID))?.status).toBe("failed");
    expect((await repo.getById(queued.id, BOOTSTRAP_ADMIN_ID))?.error).toBe("stale: process restarted while running");
    expect((await repo.getById(queued.id, BOOTSTRAP_ADMIN_ID))?.finishedAt).not.toBeNull();
    expect((await repo.getById(completed.id, BOOTSTRAP_ADMIN_ID))?.status).toBe("completed");
    expect((await repo.getById(alreadyFailed.id, BOOTSTRAP_ADMIN_ID))?.status).toBe("failed");
  });

  it("getLatestCompleted returns the most recent completed run, optionally scoped to a persona, null if none", async () => {
    const db = await createTestDb();
    const repo = createSearchRunsRepo(db);
    const resume = await insertResume(db);
    const base = { userId: BOOTSTRAP_ADMIN_ID, resumeId: resume.id, stats: { scanned: 0, matched: 0, scored: 0, worth: 0, ghosts: 0, perSource: [] } };

    expect(await repo.getLatestCompleted(BOOTSTRAP_ADMIN_ID)).toBeNull();

    const older = await repo.insert({ ...base, personas: ["remote"], status: "completed" });
    await repo.updateStatus(older.id, "completed", { finishedAt: new Date("2026-01-01T00:00:00.000Z") });
    await new Promise((r) => setTimeout(r, 5));
    const newer = await repo.insert({ ...base, personas: ["local"], status: "completed" });
    await repo.updateStatus(newer.id, "completed", { finishedAt: new Date("2026-06-01T00:00:00.000Z") });

    const latest = await repo.getLatestCompleted(BOOTSTRAP_ADMIN_ID);
    expect(latest?.id).toBe(newer.id);

    const latestRemote = await repo.getLatestCompleted(BOOTSTRAP_ADMIN_ID, "remote");
    expect(latestRemote?.id).toBe(older.id);

    expect(await repo.getLatestCompleted(BOOTSTRAP_ADMIN_ID, "local")).toMatchObject({ id: newer.id });
  });

  it("appendResult accumulates under interleaved concurrent writes (status-fenced)", async () => {
    const db = await createTestDb();
    const repo = createSearchRunsRepo(db);
    const resume = await insertResume(db, { isActive: true });
    const run = await repo.insert({
      userId: BOOTSTRAP_ADMIN_ID, resumeId: resume.id, personas: ["remote"],
      status: "running", stats: baseStatsFixture, results: [],
    });
    const mk = (n: number) => ({ jobId: `j${n}`, title: `T${n}`, company: `C${n}`, source: "s", outcome: "scored" as const, verdict: "Apply" as const, fit: 4, scoredMs: 1000 });
    await Promise.all([1, 2, 3, 4, 5].map((n) => repo.appendResult(run.id, BOOTSTRAP_ADMIN_ID, mk(n))));
    const detail = await repo.getDetail(run.id, BOOTSTRAP_ADMIN_ID);
    expect(detail?.results).toHaveLength(5);
    expect(new Set(detail!.results.map((r) => r.jobId))).toEqual(new Set(["j1", "j2", "j3", "j4", "j5"]));
  });

  it("appendResult is a no-op once the run is terminal (status fence)", async () => {
    const db = await createTestDb();
    const repo = createSearchRunsRepo(db);
    const resume = await insertResume(db, { isActive: true });
    const run = await repo.insert({ userId: BOOTSTRAP_ADMIN_ID, resumeId: resume.id, personas: ["remote"], status: "completed", stats: baseStatsFixture, results: [] });
    await repo.appendResult(run.id, BOOTSTRAP_ADMIN_ID, { jobId: "late", title: "t", company: "c", source: "s", outcome: "scored" });
    const detail = await repo.getDetail(run.id, BOOTSTRAP_ADMIN_ID);
    expect(detail?.results).toHaveLength(0);
  });

  it("appendResult is a no-op when called with a foreign userId (owner mismatch fence)", async () => {
    const db = await createTestDb();
    const repo = createSearchRunsRepo(db);
    const resume = await insertResume(db, { isActive: true });
    const [userB] = await db
      .insert(users)
      .values({ email: "user-b-searchruns-appendresult@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    const run = await repo.insert({ userId: BOOTSTRAP_ADMIN_ID, resumeId: resume.id, personas: ["remote"], status: "running", stats: baseStatsFixture, results: [] });
    await repo.appendResult(run.id, userB.id, { jobId: "foreign", title: "t", company: "c", source: "s", outcome: "scored" });
    const detail = await repo.getDetail(run.id, BOOTSTRAP_ADMIN_ID);
    expect(detail?.results).toHaveLength(0);
  });

  it("listByUser paginates newest-first, scopes to the user, and joins the résumé label", async () => {
    const db = await createTestDb();
    const repo = createSearchRunsRepo(db);
    // FK: search_runs.user_id → users.id (libsql enforces it (foreign_keys=ON)) — insert the other user first.
    const [userB] = await db
      .insert(users)
      .values({ email: "user-b-searchruns-list@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    const mine = await insertResume(db, { isActive: true, label: "mine.pdf" });
    for (let i = 0; i < 3; i++) {
      await repo.insert({ userId: BOOTSTRAP_ADMIN_ID, resumeId: mine.id, personas: ["remote"], status: "completed", stats: baseStatsFixture, results: [], startedAt: new Date(2026, 0, i + 1) });
    }
    await repo.insert({ userId: userB.id, resumeId: mine.id, personas: ["remote"], status: "completed", stats: baseStatsFixture, results: [], startedAt: new Date(2026, 0, 9) });

    const page1 = await repo.listByUser(BOOTSTRAP_ADMIN_ID, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.items[0].resumeName).toBe("mine.pdf");
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await repo.listByUser(BOOTSTRAP_ADMIN_ID, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(1); // 3 mine total, other user's row excluded
    expect(page2.nextCursor).toBeNull();
  });
});
