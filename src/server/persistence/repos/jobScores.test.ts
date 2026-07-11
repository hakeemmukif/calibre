import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { insertJob, insertResume, insertSource } from "./__fixtures__/helpers";
import { createJobScoresRepo } from "./jobScores";

describe("jobScoresRepo", () => {
  it("round-trips upsertByJobResumePolicy", async () => {
    const db = await createTestDb();
    const repo = createJobScoresRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);

    const row = await repo.upsertByJobResumePolicy({
      jobId: job.id,
      resumeId: resume.id,
      score: 4,
      verdict: "Apply",
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
      jobId: job.id,
      resumeId: resume.id,
      verdict: "Apply" as const,
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
});
