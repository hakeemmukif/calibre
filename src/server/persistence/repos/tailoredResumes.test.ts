import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { insertJob, insertResume, insertSource } from "./__fixtures__/helpers";
import { createTailoredResumesRepo } from "./tailoredResumes";

describe("tailoredResumesRepo", () => {
  it("round-trips insert/getById", async () => {
    const db = await createTestDb();
    const repo = createTailoredResumesRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);

    const inserted = await repo.insert({
      jobId: job.id,
      baseResumeId: resume.id,
      diff: [{ section: "summary", op: "modify", before: "old", after: "new", reason: "tighter framing" }],
      status: "queued",
      model: "openai/gpt-4.1",
    });

    expect(inserted.status).toBe("queued");
    expect(inserted.finalizedAt).toBeNull();
    expect(inserted.completedAt).toBeNull();

    const fetched = await repo.getById(inserted.id);
    expect(fetched?.id).toBe(inserted.id);
    expect(fetched?.diff[0].section).toBe("summary");
  });

  it("updateStatus / complete / finalize / markFailed transitions", async () => {
    const db = await createTestDb();
    const repo = createTailoredResumesRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);

    const inserted = await repo.insert({
      jobId: job.id,
      baseResumeId: resume.id,
      diff: [],
      status: "queued",
      model: "openai/gpt-4.1",
    });

    const running = await repo.updateStatus(inserted.id, "running");
    expect(running?.status).toBe("running");

    const completedAt = new Date();
    const completed = await repo.complete(inserted.id, {
      structured: resume.structured,
      diff: [{ section: "summary", op: "modify", before: "old", after: "new", reason: "sharper framing" }],
      model: "mock",
      costUsd: 0.02,
      completedAt,
    });
    expect(completed?.status).toBe("completed");
    expect(completed?.model).toBe("mock");
    expect(completed?.completedAt).not.toBeNull();

    const finalizedAt = new Date();
    const finalized = await repo.finalize(inserted.id, { structured: resume.structured, finalizedAt });
    expect(finalized?.finalizedAt).not.toBeNull();
    expect(finalized?.status).toBe("completed");

    const other = await repo.insert({ jobId: job.id, baseResumeId: resume.id, diff: [], status: "running", model: "openai/gpt-4.1" });
    const failed = await repo.markFailed(other.id);
    expect(failed?.status).toBe("failed");
  });
});
