import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { users } from "../schema";
import { insertJob, insertResume, insertSource } from "./__fixtures__/helpers";
import { createCorrelationReportsRepo } from "./correlationReports";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

describe("correlationReportsRepo", () => {
  it("insert returns a queued row", async () => {
    const db = await createTestDb();
    const repo = createCorrelationReportsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);

    const inserted = await repo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      resumeId: resume.id,
      rows: [],
      status: "queued",
      model: "openai/gpt-4.1",
    });

    expect(inserted.status).toBe("queued");
    expect(inserted.completedAt).toBeNull();
  });

  it("getById returns the row for the owner", async () => {
    const db = await createTestDb();
    const repo = createCorrelationReportsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);

    const inserted = await repo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      resumeId: resume.id,
      rows: [],
      status: "queued",
      model: "openai/gpt-4.1",
    });

    const fetched = await repo.getById(inserted.id, BOOTSTRAP_ADMIN_ID);
    expect(fetched?.id).toBe(inserted.id);
  });

  it("scopes getById to the owner", async () => {
    const db = await createTestDb();
    const repo = createCorrelationReportsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);
    const [userB] = await db
      .insert(users)
      .values({ email: "user-b-correlationreports@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();

    const row = await repo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      resumeId: resume.id,
      rows: [],
      status: "queued",
      model: "m",
    });
    expect(await repo.getById(row.id, userB.id)).toBeNull();
    expect(await repo.getById(row.id, BOOTSTRAP_ADMIN_ID)).not.toBeNull();
  });

  it("complete sets rows/semantic/ats/status/completedAt", async () => {
    const db = await createTestDb();
    const repo = createCorrelationReportsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);

    const inserted = await repo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      resumeId: resume.id,
      rows: [],
      status: "queued",
      model: "openai/gpt-4.1",
    });

    const completedAt = new Date();
    const rows = [
      {
        requirement: "5+ years backend",
        term: "backend",
        kind: "must" as const,
        status: "met" as const,
        evidence: "Backend engineer for 6 years",
        atsPresent: true,
        reason: "explicit experience match",
        note: null,
      },
    ];
    const completed = await repo.complete(inserted.id, {
      rows,
      semantic: { met: 1, buried: 0, gap: 0, total: 1 },
      ats: { present: 1, total: 1, missing: [] },
      model: "mock",
      costUsd: 0.01,
      completedAt,
    });

    expect(completed?.status).toBe("completed");
    expect(completed?.rows).toEqual(rows);
    expect(completed?.semantic).toEqual({ met: 1, buried: 0, gap: 0, total: 1 });
    expect(completed?.ats).toEqual({ present: 1, total: 1, missing: [] });
    expect(completed?.completedAt).not.toBeNull();
  });

  it("markFailed sets failed", async () => {
    const db = await createTestDb();
    const repo = createCorrelationReportsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);

    const inserted = await repo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      resumeId: resume.id,
      rows: [],
      status: "running",
      model: "openai/gpt-4.1",
    });

    const failed = await repo.markFailed(inserted.id);
    expect(failed?.status).toBe("failed");
  });
});
