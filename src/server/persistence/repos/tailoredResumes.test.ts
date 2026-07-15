import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { users } from "../schema";
import { insertJob, insertResume, insertSource } from "./__fixtures__/helpers";
import { createTailoredResumesRepo } from "./tailoredResumes";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

describe("tailoredResumesRepo", () => {
  it("round-trips insert/getById", async () => {
    const db = await createTestDb();
    const repo = createTailoredResumesRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);

    const inserted = await repo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      baseResumeId: resume.id,
      diff: [{ section: "summary", op: "modify", before: "old", after: "new", reason: "tighter framing", requirement: "summary relevance", target: { index: null, bulletIndex: null } }],
      status: "queued",
      model: "openai/gpt-4.1",
    });

    expect(inserted.status).toBe("queued");
    expect(inserted.finalizedAt).toBeNull();
    expect(inserted.completedAt).toBeNull();

    const fetched = await repo.getById(inserted.id, BOOTSTRAP_ADMIN_ID);
    expect(fetched?.id).toBe(inserted.id);
    expect(fetched?.diff[0].section).toBe("summary");
  });

  it("getById is scoped by userId — a foreign-owned tailor run resolves to null (no existence leak)", async () => {
    const db = await createTestDb();
    const repo = createTailoredResumesRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);
    const [userB] = await db
      .insert(users)
      .values({ email: "user-b-tailoredresumes@example.com", passwordHash: "h", role: "user" })
      .returning();

    const inserted = await repo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      baseResumeId: resume.id,
      diff: [],
      status: "queued",
      model: "openai/gpt-4.1",
    });

    expect(await repo.getById(inserted.id, userB.id)).toBeNull();
    expect((await repo.getById(inserted.id, BOOTSTRAP_ADMIN_ID))?.id).toBe(inserted.id);
  });

  it("updateStatus / complete / finalize / markFailed transitions", async () => {
    const db = await createTestDb();
    const repo = createTailoredResumesRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);

    const inserted = await repo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
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
      diff: [{ section: "summary", op: "modify", before: "old", after: "new", reason: "sharper framing", requirement: "summary relevance", target: { index: null, bulletIndex: null } }],
      model: "mock",
      costUsd: 0.02,
      completedAt,
    });
    expect(completed?.status).toBe("completed");
    expect(completed?.model).toBe("mock");
    expect(completed?.completedAt).not.toBeNull();

    const finalizedAt = new Date();
    const finalized = await repo.finalize(inserted.id, { acceptedIndices: [0], finalizedAt });
    expect(finalized?.finalizedAt).not.toBeNull();
    expect(finalized?.status).toBe("completed");
    expect(finalized?.acceptedIndices).toEqual([0]);
    // task-B8 review fix (Finding 2): finalize must NOT overwrite `structured`
    // — it stays the immutable tailored draft so a later re-finalize with a
    // different accepted set can still recompute from it.
    expect(finalized?.structured).toEqual(resume.structured);

    const other = await repo.insert({ userId: BOOTSTRAP_ADMIN_ID, jobId: job.id, baseResumeId: resume.id, diff: [], status: "running", model: "openai/gpt-4.1" });
    const failed = await repo.markFailed(other.id);
    expect(failed?.status).toBe("failed");
  });
});
