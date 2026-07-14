import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { insertJob, insertResume, insertSource } from "./__fixtures__/helpers";
import { createJobScoresRepo } from "./jobScores";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

describe("jobScoresRepo", () => {
  it("round-trips upsertByJobResumePolicy", async () => {
    const db = await createTestDb();
    const repo = createJobScoresRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);

    const row = await repo.upsertByJobResumePolicy({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      resumeId: resume.id,
      score: 4,
      verdict: "Apply",
      why: "Matches core stack.",
      legitimacy: { tier: "clear", tone: "good", summary: "x", signals: [] },
      liveness: "active",
      breakdown: [],
      reasons: { for: [], against: [] },
      fit: [],
      gaps: [],
      jdFacts: {},
      model: "m1",
      escalated: false,
      costUsd: 0.02,
      policyVersion: "v1",
    });

    expect(row.score).toBe(4);
    const fetched = await repo.getById(row.id);
    expect(fetched?.id).toBe(row.id);
  });

  it("re-scoring the same (jobId,resumeId,policyVersion) tuple updates in place, not duplicates", async () => {
    const db = await createTestDb();
    const repo = createJobScoresRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);

    const base = {
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      resumeId: resume.id,
      verdict: "Apply" as const,
      why: "Matches core stack.",
      legitimacy: { tier: "clear" as const, tone: "good" as const, summary: "x", signals: [] },
      liveness: "active" as const,
      breakdown: [],
      reasons: { for: [], against: [] },
      fit: [],
      gaps: [],
      jdFacts: {},
      model: "m1",
      escalated: false,
      costUsd: 0.02,
      policyVersion: "v1",
    };

    const first = await repo.upsertByJobResumePolicy({ ...base, score: 3.5 });
    const second = await repo.upsertByJobResumePolicy({ ...base, score: 4.8, escalated: true });

    expect(second.id).toBe(first.id);
    expect(second.score).toBe(4.8);
    expect(second.escalated).toBe(true);
  });

  it("sumCostUsdSince sums only rows created at/after the cutoff", async () => {
    const db = await createTestDb();
    const repo = createJobScoresRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const jobA = await insertJob(db, source.id, { dedupeKey: "dk-cost-a", url: "https://example.com/cost-a" });
    const jobB = await insertJob(db, source.id, { dedupeKey: "dk-cost-b", url: "https://example.com/cost-b" });

    const base = {
      userId: BOOTSTRAP_ADMIN_ID,
      resumeId: resume.id,
      verdict: "Apply" as const,
      why: "x",
      legitimacy: { tier: "clear" as const, tone: "good" as const, summary: "x", signals: [] },
      liveness: "active" as const,
      breakdown: [],
      reasons: { for: [], against: [] },
      fit: [],
      gaps: [],
      jdFacts: {},
      model: "m1",
      escalated: false,
      policyVersion: "v1",
      score: 4,
    };

    await repo.upsertByJobResumePolicy({ ...base, jobId: jobA.id, costUsd: 0.01 });
    await repo.upsertByJobResumePolicy({ ...base, jobId: jobB.id, costUsd: 0.02 });

    const total = await repo.sumCostUsdSince(new Date("2000-01-01T00:00:00.000Z"));
    expect(total).toBeCloseTo(0.03);

    const none = await repo.sumCostUsdSince(new Date("2999-01-01T00:00:00.000Z"));
    expect(none).toBe(0);
  });

  it("getLatestByJobId returns the most recently created row for a job, or null", async () => {
    const db = await createTestDb();
    const repo = createJobScoresRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);

    expect(await repo.getLatestByJobId(job.id)).toBeNull();

    const base = {
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      resumeId: resume.id,
      verdict: "Apply" as const,
      why: "x",
      legitimacy: { tier: "clear" as const, tone: "good" as const, summary: "x", signals: [] },
      liveness: "active" as const,
      breakdown: [],
      reasons: { for: [], against: [] },
      fit: [],
      gaps: [],
      jdFacts: { title: "Backend Engineer" },
      model: "m1",
      escalated: false,
      costUsd: 0.01,
      score: 4,
    };

    await repo.upsertByJobResumePolicy({
      ...base,
      policyVersion: "v1",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const latest = await repo.upsertByJobResumePolicy({
      ...base,
      policyVersion: "v2",
      score: 4.5,
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    });

    const found = await repo.getLatestByJobId(job.id);
    expect(found?.id).toBe(latest.id);
    expect(found?.jdFacts).toEqual({ title: "Backend Engineer" });
  });

  it("getLatestByJobId is deterministic across repeated queries when created_at ties", async () => {
    const db = await createTestDb();
    const repo = createJobScoresRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);

    const base = {
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      resumeId: resume.id,
      verdict: "Apply" as const,
      why: "x",
      legitimacy: { tier: "clear" as const, tone: "good" as const, summary: "x", signals: [] },
      liveness: "active" as const,
      breakdown: [],
      reasons: { for: [], against: [] },
      fit: [],
      gaps: [],
      jdFacts: {},
      model: "m1",
      escalated: false,
      costUsd: 0.01,
      score: 4,
    };

    const tiedCreatedAt = new Date("2026-01-01T00:00:00.000Z");
    await repo.upsertByJobResumePolicy({ ...base, policyVersion: "v1", createdAt: tiedCreatedAt });
    const second = await repo.upsertByJobResumePolicy({
      ...base,
      policyVersion: "v2",
      createdAt: tiedCreatedAt,
    });

    const firstQuery = await repo.getLatestByJobId(job.id);
    const secondQuery = await repo.getLatestByJobId(job.id);
    const thirdQuery = await repo.getLatestByJobId(job.id);

    expect(firstQuery?.id).toBe(secondQuery?.id);
    expect(secondQuery?.id).toBe(thirdQuery?.id);
    // The tie-break is desc(id): the row with the lexicographically greater
    // uuid wins, stably, regardless of insert order.
    const expectedWinner = [second.id, firstQuery?.id].sort().reverse()[0];
    expect(firstQuery?.id).toBe(expectedWinner);
  });
});
