import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { insertJob, insertSource } from "./__fixtures__/helpers";
import { createUrlChecksRepo } from "./urlChecks";

describe("urlChecksRepo", () => {
  it("round-trips insert/getById", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);

    const inserted = await repo.insert({
      url: "https://boards.greenhouse.io/example/jobs/123",
      dedupeKey: "greenhouse.io/example/jobs/123",
      status: "queued",
      alreadyKnown: false,
      needsText: false,
      costUsd: 0,
      raw: { pastedText: null },
    });
    expect(inserted.status).toBe("queued");
    expect(inserted.jobId).toBeNull();
    expect(inserted.finishedAt).toBeNull();

    const fetched = await repo.getById(inserted.id);
    expect(fetched?.id).toBe(inserted.id);
    expect(await repo.getById("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("updateStage sets stage without touching status", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);
    const inserted = await repo.insert({
      url: "https://x.example/job", dedupeKey: "x.example/job", status: "running",
      alreadyKnown: false, needsText: false, costUsd: 0, raw: {},
    });

    const staged = await repo.updateStage(inserted.id, "fetching");
    expect(staged?.stage).toBe("fetching");
    expect(staged?.status).toBe("running");
  });

  it("complete sets status completed, jobId, alreadyKnown, finishedAt", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);
    const source = await insertSource(db);
    const job = await insertJob(db, source.id);
    const inserted = await repo.insert({
      url: "https://x.example/job", dedupeKey: "x.example/job", status: "running",
      alreadyKnown: false, needsText: false, costUsd: 0, raw: {},
    });

    const done = await repo.complete(inserted.id, { jobId: job.id, alreadyKnown: true });
    expect(done?.status).toBe("completed");
    expect(done?.jobId).toBe(job.id);
    expect(done?.alreadyKnown).toBe(true);
    expect(done?.finishedAt).not.toBeNull();
  });

  it("fail sets status failed, error, needsText, finishedAt", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);
    const inserted = await repo.insert({
      url: "https://x.example/job", dedupeKey: "x.example/job", status: "running",
      alreadyKnown: false, needsText: false, costUsd: 0, raw: {},
    });

    const failed = await repo.fail(inserted.id, {
      code: "NOT_A_JOB_POSTING", message: "page is not a job posting", needsText: true,
    });
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toEqual({ code: "NOT_A_JOB_POSTING", message: "page is not a job posting" });
    expect(failed?.needsText).toBe(true);
    expect(failed?.finishedAt).not.toBeNull();
  });

  it("addCost accumulates costUsd across multiple calls", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);
    const inserted = await repo.insert({
      url: "https://x.example/job", dedupeKey: "x.example/job", status: "running",
      alreadyKnown: false, needsText: false, costUsd: 0, raw: {},
    });

    await repo.addCost(inserted.id, 0.01);
    const after = await repo.addCost(inserted.id, 0.005);
    expect(after?.costUsd).toBeCloseTo(0.015, 6);
  });
});
