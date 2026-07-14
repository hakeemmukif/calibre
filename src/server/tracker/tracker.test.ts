import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { insertJob, insertJobScore, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { applications, jobs, jobScores, resumes, sources, tailoredResumes } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { markApplied, listApplications, patchApplication, UnknownJobError, NoActiveResumeError, JobNotScoredError } =
  await import("./index");
const { ApplicationConflictError } = await import("@/server/persistence/repos/applications");
const { createTailoredResumesRepo } = await import("@/server/persistence/repos/tailoredResumes");

async function setupScoredJob(overrides: Parameters<typeof insertJob>[2] = {}) {
  const source = await insertSource(state.testDb);
  // insertReplacingActive (not the raw insertResume fixture) — setupScoredJob
  // is called more than once per test in some cases, and the migration's
  // resumes_user_id_active_unique partial index now rejects a second
  // isActive:true row for the same user; insertReplacingActive clamps to one
  // active résumé the same way the real write path does.
  const { createResumesRepo } = await import("@/server/persistence/repos/resumes");
  const resume = await createResumesRepo(state.testDb).insertReplacingActive({
    userId: BOOTSTRAP_ADMIN_ID,
    rawText: "Jane Doe — Software Engineer",
    structured: {
      name: "Jane Doe",
      contact: [{ label: "email", value: "jane@example.com" }],
      summary: "Backend engineer.",
      experience: [],
      education: [],
      skills: [],
      extras: [],
    },
    sourceKind: "paste",
    isActive: true,
  });
  const job = await insertJob(state.testDb, source.id, overrides);
  await insertJobScore(state.testDb, job.id, resume.id, { score: 4.2 });
  return { job, resume };
}

describe("server/tracker", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  afterEach(async () => {
    await state.testDb.delete(applications);
    await state.testDb.delete(jobScores);
    await state.testDb.delete(tailoredResumes);
    await state.testDb.delete(jobs);
    await state.testDb.delete(resumes);
    await state.testDb.delete(sources);
  });

  describe("markApplied", () => {
    it("unknown jobId -> UnknownJobError", async () => {
      await expect(markApplied({ jobId: crypto.randomUUID() })).rejects.toThrow(UnknownJobError);
    });

    it("no active résumé -> NoActiveResumeError", async () => {
      const source = await insertSource(state.testDb);
      const resume = await insertResume(state.testDb, { isActive: false });
      const job = await insertJob(state.testDb, source.id);
      await insertJobScore(state.testDb, job.id, resume.id);

      await expect(markApplied({ jobId: job.id })).rejects.toThrow(NoActiveResumeError);
    });

    it("inserts a stage-0 'good' row with appliedAt set, and returns role/company/meta/score from the join", async () => {
      const { job } = await setupScoredJob({ title: "Staff Engineer", company: "Acme Corp", location: "Remote" });

      const app = await markApplied({ jobId: job.id, note: "referred by Alex" });

      expect(app.jobId).toBe(job.id);
      expect(app.stage).toBe(0);
      expect(app.statusLabel).toBe("Applied");
      expect(app.statusTone).toBe("good");
      expect(app.role).toBe("Staff Engineer");
      expect(app.company).toBe("Acme Corp");
      expect(app.score).toBe(4.2);
      expect(app.note).toBe("referred by Alex");
      expect(app.tailored).toBe(false);
      expect(new Date(app.appliedAt).getTime()).not.toBeNaN();
    });

    it("sets tailored:true when a tailoredResumeId is provided", async () => {
      const { job, resume } = await setupScoredJob();
      const tailoredResume = await createTailoredResumesRepo(state.testDb).insert({
        userId: BOOTSTRAP_ADMIN_ID,
        jobId: job.id,
        baseResumeId: resume.id,
        diff: [],
        status: "queued",
        model: "test-model",
      });

      const app = await markApplied({ jobId: job.id, tailoredResumeId: tailoredResume.id });
      expect(app.tailored).toBe(true);
    });

    it("existing but unscored job -> clean error, no orphaned application row", async () => {
      const source = await insertSource(state.testDb);
      await insertResume(state.testDb, { isActive: true });
      const job = await insertJob(state.testDb, source.id);
      // deliberately no insertJobScore — job exists but is unscored

      await expect(markApplied({ jobId: job.id })).rejects.toThrow(JobNotScoredError);

      const rows = await state.testDb.select().from(applications);
      expect(rows).toHaveLength(0);
    });

    it("duplicate jobId -> ApplicationConflictError with existingId", async () => {
      const { job } = await setupScoredJob();
      const first = await markApplied({ jobId: job.id });

      try {
        await markApplied({ jobId: job.id });
        throw new Error("expected markApplied to reject");
      } catch (err) {
        expect(err).toBeInstanceOf(ApplicationConflictError);
        expect((err as InstanceType<typeof ApplicationConflictError>).existingId).toBe(first.id);
      }
    });
  });

  describe("listApplications", () => {
    it("filters by stage and statusTone", async () => {
      const { job: jobA } = await setupScoredJob();
      const { job: jobB } = await setupScoredJob();
      const appA = await markApplied({ jobId: jobA.id });
      await markApplied({ jobId: jobB.id });
      await patchApplication(appA.id, { stage: 2 });

      const byStage = await listApplications({ stage: 2 });
      expect(byStage.items.map((a) => a.id)).toEqual([appA.id]);

      const byTone = await listApplications({ statusTone: "good" });
      expect(byTone.items.every((a) => a.statusTone === "good")).toBe(true);
    });

    it("pages via cursor", async () => {
      const { job: jobA } = await setupScoredJob();
      const { job: jobB } = await setupScoredJob();
      await markApplied({ jobId: jobA.id });
      await markApplied({ jobId: jobB.id });

      const page1 = await listApplications({ limit: 1 });
      expect(page1.items).toHaveLength(1);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await listApplications({ limit: 1, cursor: page1.nextCursor! });
      expect(page2.items).toHaveLength(1);
      expect(page2.nextCursor).toBeNull();
      expect(page2.items[0].id).not.toBe(page1.items[0].id);
    });
  });

  describe("patchApplication", () => {
    it("stage move with no explicit status re-folds via foldStatus(newStage, 'open')", async () => {
      const { job } = await setupScoredJob();
      const app = await markApplied({ jobId: job.id });

      const patched = await patchApplication(app.id, { stage: 2 });
      expect(patched?.stage).toBe(2);
      expect(patched?.statusLabel).toBe("Interviewing");
      expect(patched?.statusTone).toBe("good");
    });

    it("an explicit statusTone/statusLabel wins over the stage-move re-fold", async () => {
      const { job } = await setupScoredJob();
      const app = await markApplied({ jobId: job.id });

      const patched = await patchApplication(app.id, { stage: 3, statusLabel: "Offer", statusTone: "verified" });
      expect(patched?.stage).toBe(3);
      expect(patched?.statusLabel).toBe("Offer");
      expect(patched?.statusTone).toBe("verified");
    });

    it("note-only patch does not touch stage/status", async () => {
      const { job } = await setupScoredJob();
      const app = await markApplied({ jobId: job.id });

      const patched = await patchApplication(app.id, { note: "recruiter call scheduled" });
      expect(patched?.note).toBe("recruiter call scheduled");
      expect(patched?.stage).toBe(0);
      expect(patched?.statusLabel).toBe("Applied");
    });

    it("unknown id -> null", async () => {
      const result = await patchApplication(crypto.randomUUID(), { note: "x" });
      expect(result).toBeNull();
    });
  });
});
