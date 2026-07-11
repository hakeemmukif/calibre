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
      stats: { scanned: 0, matched: 0, scored: 0, ghosts: 0, perSource: [] },
    });
    expect(inserted.status).toBe("queued");

    const running = await repo.updateStatus(inserted.id, "running");
    expect(running?.status).toBe("running");

    const withStats = await repo.updateStats(inserted.id, {
      scanned: 10,
      matched: 5,
      scored: 3,
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

    const base = { resumeId: resume.id, personas: ["remote" as const], stats: { scanned: 0, matched: 0, scored: 0, ghosts: 0, perSource: [] } };
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
});
