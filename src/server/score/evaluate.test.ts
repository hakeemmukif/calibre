import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MATCH_SCORE } from "@/lib/llm/scripted-fixtures";
import { insertJob, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { jobs, jobScores, resumes, sources } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { Job } from "@/types";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));
vi.mock("./liveness", () => ({ probeLivenessDeep: vi.fn().mockResolvedValue("active") }));

const { evaluateJob, UnknownJobError } = await import("./evaluate");
const { EmptyJobDescriptionError } = await import("./index");
const { NoActiveResumeError } = await import("@/server/search/run");

describe("evaluateJob", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(sources);
    await state.testDb.delete(resumes);
  });

  it("throws UnknownJobError for an unknown job id", async () => {
    await expect(evaluateJob(crypto.randomUUID())).rejects.toThrow(UnknownJobError);
  });

  it("throws NoActiveResumeError when no résumé is active", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { description: "Backend role at Acme." });
    await insertResume(state.testDb); // isActive: false by default

    await expect(evaluateJob(job.id)).rejects.toThrow(NoActiveResumeError);
  });

  it("happy path: returns a Job.parse-valid job whose score matches the scripted MATCH_SCORE fixture, and persists a job_scores row", async () => {
    vi.stubEnv("CALIBER_TEST_DOUBLES", "1");
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { description: "Backend role at Acme." });
    const resume = await insertResume(state.testDb, { isActive: true });

    const result = await evaluateJob(job.id);

    expect(() => Job.parse(result)).not.toThrow();
    expect(result.id).toBe(job.id);
    expect(result.score).toBeCloseTo(MATCH_SCORE.score);

    const rows = await state.testDb.select().from(jobScores).where(eq(jobScores.jobId, job.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].resumeId).toBe(resume.id);
  });

  it("a null-description job with a no-fetchDetail source throws EmptyJobDescriptionError", async () => {
    vi.stubEnv("CALIBER_TEST_DOUBLES", "1");
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { description: null });
    await insertResume(state.testDb, { isActive: true });

    await expect(evaluateJob(job.id)).rejects.toThrow(EmptyJobDescriptionError);
  });
});
