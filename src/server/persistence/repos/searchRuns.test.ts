import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { users } from "../schema";
import { insertResume } from "./__fixtures__/helpers";
import { createSearchRunsRepo } from "./searchRuns";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

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
      .values({ email: "user-b-searchruns-getbyid@example.com", passwordHash: "h", role: "user" })
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
      .values({ email: "user-b-searchruns@example.com", passwordHash: "h", role: "user" })
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
});
