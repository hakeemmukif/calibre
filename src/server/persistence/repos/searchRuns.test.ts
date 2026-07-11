import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { insertResume } from "./__fixtures__/helpers";
import { createSearchRunsRepo } from "./searchRuns";

describe("searchRunsRepo", () => {
  it("round-trips insert/getById and updates status + stats", async () => {
    const db = await createTestDb();
    const repo = createSearchRunsRepo(db);
    const resume = await insertResume(db);

    const inserted = await repo.insert({
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

    const fetched = await repo.getById(inserted.id);
    expect(fetched?.id).toBe(inserted.id);
  });

  it("markAllRunningAsFailed flips only 'running' rows to 'failed' with an error and finishedAt", async () => {
    const db = await createTestDb();
    const repo = createSearchRunsRepo(db);
    const resume = await insertResume(db);

    const base = { resumeId: resume.id, personas: ["remote" as const], stats: { scanned: 0, matched: 0, scored: 0, worth: 0, ghosts: 0, perSource: [] } };
    const running = await repo.insert({ ...base, status: "running" });
    const queued = await repo.insert({ ...base, status: "queued" });
    const completed = await repo.insert({ ...base, status: "completed" });

    const flipped = await repo.markAllRunningAsFailed("stale: process restarted while running");
    expect(flipped.map((r) => r.id)).toEqual([running.id]);

    expect((await repo.getById(running.id))?.status).toBe("failed");
    expect((await repo.getById(running.id))?.error).toBe("stale: process restarted while running");
    expect((await repo.getById(running.id))?.finishedAt).not.toBeNull();
    expect((await repo.getById(queued.id))?.status).toBe("queued");
    expect((await repo.getById(completed.id))?.status).toBe("completed");
  });

  it("getLatestCompleted returns the most recent completed run, optionally scoped to a persona, null if none", async () => {
    const db = await createTestDb();
    const repo = createSearchRunsRepo(db);
    const resume = await insertResume(db);
    const base = { resumeId: resume.id, stats: { scanned: 0, matched: 0, scored: 0, worth: 0, ghosts: 0, perSource: [] } };

    expect(await repo.getLatestCompleted()).toBeNull();

    const older = await repo.insert({ ...base, personas: ["remote"], status: "completed" });
    await repo.updateStatus(older.id, "completed", { finishedAt: new Date("2026-01-01T00:00:00.000Z") });
    await new Promise((r) => setTimeout(r, 5));
    const newer = await repo.insert({ ...base, personas: ["local"], status: "completed" });
    await repo.updateStatus(newer.id, "completed", { finishedAt: new Date("2026-06-01T00:00:00.000Z") });

    const latest = await repo.getLatestCompleted();
    expect(latest?.id).toBe(newer.id);

    const latestRemote = await repo.getLatestCompleted("remote");
    expect(latestRemote?.id).toBe(older.id);

    expect(await repo.getLatestCompleted("local")).toMatchObject({ id: newer.id });
  });
});
