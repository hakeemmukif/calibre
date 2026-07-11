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
});
