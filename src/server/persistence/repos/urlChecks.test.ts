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

  it("markAllUnfinishedAsFailed flips 'queued' and 'running' rows to 'failed', leaves completed/failed untouched", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);
    const base = { url: "https://x.example/job", dedupeKey: "x.example/job", alreadyKnown: false, needsText: false, costUsd: 0, raw: {} };

    const running = await repo.insert({ ...base, status: "running" });
    const queued = await repo.insert({ ...base, status: "queued" });
    const completed = await repo.insert({ ...base, status: "completed" });
    const alreadyFailed = await repo.insert({ ...base, status: "failed" });

    const flippedCount = await repo.markAllUnfinishedAsFailed();
    expect(flippedCount).toBe(2);

    expect((await repo.getById(running.id))?.status).toBe("failed");
    expect((await repo.getById(running.id))?.error).toMatchObject({ code: "INTERNAL" });
    expect((await repo.getById(running.id))?.finishedAt).not.toBeNull();
    expect((await repo.getById(queued.id))?.status).toBe("failed");
    expect((await repo.getById(completed.id))?.status).toBe("completed");
    expect((await repo.getById(alreadyFailed.id))?.status).toBe("failed");
  });
});

function queuedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    url: "https://example.com/job",
    dedupeKey: "example.com/job",
    status: "queued" as const,
    stage: null,
    jobId: null,
    alreadyKnown: false,
    needsText: false,
    error: null,
    costUsd: 0,
    raw: { text: null },
    ...overrides,
  };
}

describe("url_checks schema", () => {
  it("defaults attempts to 0 and leaseExpiresAt to null on insert", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);
    const row = await repo.insert(queuedRow());
    expect(row.attempts).toBe(0);
    expect(row.leaseExpiresAt).toBeNull();
  });
});
