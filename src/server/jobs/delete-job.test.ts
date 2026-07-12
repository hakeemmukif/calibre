import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { insertJob, insertJobScore, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import {
  applicationAnswers,
  applications,
  jobs,
  jobScores,
  resumes,
  sources,
  tailoredResumes,
  urlChecks,
} from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { deletePastedJob, UnknownJobError, NotDeletableError, ApplicationExistsError } = await import("./delete-job");
const { createUrlChecksRepo } = await import("@/server/persistence/repos/urlChecks");

describe("deletePastedJob", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  afterEach(async () => {
    await state.testDb.delete(applicationAnswers);
    await state.testDb.delete(applications);
    await state.testDb.delete(tailoredResumes);
    await state.testDb.delete(urlChecks);
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(resumes);
    await state.testDb.delete(sources);
  });

  it("unknown jobId -> UnknownJobError", async () => {
    await expect(deletePastedJob(crypto.randomUUID())).rejects.toThrow(UnknownJobError);
  });

  it("persona !== 'pasted' -> NotDeletableError, distinct message from ApplicationExistsError", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { persona: "remote" });

    await expect(deletePastedJob(job.id)).rejects.toThrow(NotDeletableError);
    try {
      await deletePastedJob(job.id);
      throw new Error("expected deletePastedJob to throw");
    } catch (err) {
      expect((err as Error).message).not.toMatch(/tracked application/);
    }
  });

  it("pasted job with a tracked application -> ApplicationExistsError, jobs row untouched", async () => {
    const source = await insertSource(state.testDb);
    const resume = await insertResume(state.testDb, { isActive: true });
    const job = await insertJob(state.testDb, source.id, { persona: "pasted" });
    await insertJobScore(state.testDb, job.id, resume.id);
    await state.testDb.insert(applications).values({
      jobId: job.id,
      resumeId: resume.id,
      stage: 0,
      statusLabel: "Applied",
      statusTone: "good",
      note: "",
    });

    await expect(deletePastedJob(job.id)).rejects.toThrow(ApplicationExistsError);
    const [stillThere] = await state.testDb.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, job.id));
    expect(stillThere).toBeTruthy();
  });

  it("deletes application_answers, tailored_resumes, job_scores, jobs, and nulls url_checks.job_id via FK", async () => {
    const source = await insertSource(state.testDb);
    const resume = await insertResume(state.testDb, { isActive: true });
    const job = await insertJob(state.testDb, source.id, { persona: "pasted" });
    await insertJobScore(state.testDb, job.id, resume.id);
    await state.testDb.insert(tailoredResumes).values({
      jobId: job.id,
      baseResumeId: resume.id,
      diff: [],
      status: "completed",
      model: "test-model",
    });
    await state.testDb.insert(applicationAnswers).values({
      jobId: job.id,
      resumeId: resume.id,
      formSource: "pasted",
      answers: [],
      model: "test-model",
      costUsd: 0,
    });
    const urlCheck = await createUrlChecksRepo(state.testDb).insert({
      url: job.url,
      dedupeKey: job.dedupeKey,
      status: "completed",
      stage: null,
      jobId: job.id,
      alreadyKnown: false,
      needsText: false,
      error: null,
      costUsd: 0,
      raw: {},
    });

    await deletePastedJob(job.id);

    const [gone] = await state.testDb.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, job.id));
    expect(gone).toBeUndefined();
    const remainingScores = await state.testDb.select().from(jobScores).where(eq(jobScores.jobId, job.id));
    expect(remainingScores).toHaveLength(0);
    const remainingTailored = await state.testDb.select().from(tailoredResumes).where(eq(tailoredResumes.jobId, job.id));
    expect(remainingTailored).toHaveLength(0);
    const remainingAnswers = await state.testDb.select().from(applicationAnswers).where(eq(applicationAnswers.jobId, job.id));
    expect(remainingAnswers).toHaveLength(0);
    const [checkAfter] = await state.testDb.select().from(urlChecks).where(eq(urlChecks.id, urlCheck.id));
    expect(checkAfter.jobId).toBeNull();
  });
});
