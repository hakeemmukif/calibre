import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { insertJob, insertJobScore, insertResume, insertSource } from "./__fixtures__/helpers";
import { ApplicationConflictError, createApplicationsRepo } from "./applications";

describe("applicationsRepo", () => {
  it("round-trips insertUniqueByJob", async () => {
    const db = await createTestDb();
    const repo = createApplicationsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);

    const app = await repo.insertUniqueByJob({
      jobId: job.id,
      resumeId: resume.id,
      stage: 0,
      statusLabel: "Applied",
      statusTone: "good",
      note: "",
    });

    expect(app.jobId).toBe(job.id);
    expect(app.stage).toBe(0);
  });

  it("throws ApplicationConflictError with the existing id on duplicate jobId", async () => {
    const db = await createTestDb();
    const repo = createApplicationsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);

    const first = await repo.insertUniqueByJob({
      jobId: job.id,
      resumeId: resume.id,
      stage: 0,
      statusLabel: "Applied",
      statusTone: "good",
      note: "",
    });

    await expect(
      repo.insertUniqueByJob({
        jobId: job.id,
        resumeId: resume.id,
        stage: 0,
        statusLabel: "Applied",
        statusTone: "good",
        note: "",
      }),
    ).rejects.toThrow(ApplicationConflictError);

    try {
      await repo.insertUniqueByJob({
        jobId: job.id,
        resumeId: resume.id,
        stage: 0,
        statusLabel: "Applied",
        statusTone: "good",
        note: "",
      });
      throw new Error("expected insertUniqueByJob to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ApplicationConflictError);
      expect((err as ApplicationConflictError).existingId).toBe(first.id);
    }
  });

  it("listJoined yields role/company/meta/score from the job+score join", async () => {
    const db = await createTestDb();
    const repo = createApplicationsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id, {
      title: "Staff Engineer",
      company: "Acme Corp",
      location: "Kuala Lumpur",
      salaryRaw: "RM12k-16k",
    });
    await insertJobScore(db, job.id, resume.id, { score: 4.7 });
    await repo.insertUniqueByJob({
      jobId: job.id,
      resumeId: resume.id,
      stage: 0,
      statusLabel: "Applied",
      statusTone: "good",
      note: "",
    });

    const { items } = await repo.listJoined({});
    expect(items).toHaveLength(1);
    expect(items[0].role).toBe("Staff Engineer");
    expect(items[0].company).toBe("Acme Corp");
    expect(items[0].meta).toBe("Kuala Lumpur · RM12k-16k");
    expect(items[0].score).toBe(4.7);
  });

  it("getJoined returns a single joined row", async () => {
    const db = await createTestDb();
    const repo = createApplicationsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);
    await insertJobScore(db, job.id, resume.id);
    const app = await repo.insertUniqueByJob({
      jobId: job.id,
      resumeId: resume.id,
      stage: 0,
      statusLabel: "Applied",
      statusTone: "good",
      note: "",
    });

    const found = await repo.getJoined(app.id);
    expect(found?.id).toBe(app.id);
    expect(found?.role).toBeDefined();
  });

  it("patch updates stage/status/note", async () => {
    const db = await createTestDb();
    const repo = createApplicationsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);
    await insertJobScore(db, job.id, resume.id);
    const app = await repo.insertUniqueByJob({
      jobId: job.id,
      resumeId: resume.id,
      stage: 0,
      statusLabel: "Applied",
      statusTone: "good",
      note: "",
    });

    const patched = await repo.patch(app.id, { stage: 1, statusLabel: "Screening", note: "recruiter call" });
    expect(patched?.stage).toBe(1);
    expect(patched?.statusLabel).toBe("Screening");
    expect(patched?.note).toBe("recruiter call");
  });
});
