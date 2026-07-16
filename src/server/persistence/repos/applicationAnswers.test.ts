import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { users } from "../schema";
import { insertJob, insertResume, insertSource } from "./__fixtures__/helpers";
import { createApplicationAnswersRepo } from "./applicationAnswers";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

describe("applicationAnswersRepo", () => {
  it("round-trips insert/getById", async () => {
    const db = await createTestDb();
    const repo = createApplicationAnswersRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);

    const inserted = await repo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      resumeId: resume.id,
      formSource: "pasted",
      answers: [
        {
          questionId: "q1",
          prompt: "Why do you want this role?",
          answer: "Because...",
          grounding: [{ source: "summary", quote: "Backend engineer." }],
        },
      ],
      model: "m1",
      costUsd: 0.01,
    });

    expect(inserted.answers).toHaveLength(1);
    const fetched = await repo.getById(inserted.id, BOOTSTRAP_ADMIN_ID);
    expect(fetched?.id).toBe(inserted.id);
    expect(fetched?.answers[0].questionId).toBe("q1");
  });

  it("getById is scoped by userId — a foreign-owned answers row resolves to null (no existence leak)", async () => {
    const db = await createTestDb();
    const repo = createApplicationAnswersRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);
    const [userB] = await db
      .insert(users)
      .values({ email: "user-b-answers-getbyid@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();

    const inserted = await repo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      resumeId: resume.id,
      formSource: "pasted",
      answers: [{ questionId: "q1", prompt: "Why us?", answer: "Because...", grounding: [] }],
      model: "m1",
      costUsd: 0.01,
    });

    expect(await repo.getById(inserted.id, userB.id)).toBeNull();
  });

  it("update() replaces the persisted answer set and getById() reflects it", async () => {
    const db = await createTestDb();
    const repo = createApplicationAnswersRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);

    const inserted = await repo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      resumeId: resume.id,
      formSource: "pasted",
      answers: [{ questionId: "q1", prompt: "Why us?", answer: "Because...", grounding: [] }],
      model: "m1",
      costUsd: 0.01,
    });

    const updated = await repo.update(inserted.id, BOOTSTRAP_ADMIN_ID, [
      { questionId: "q1", prompt: "Why us?", answer: "Edited answer.", grounding: [{ source: "summary", quote: "Backend engineer." }] },
    ]);

    expect(updated?.answers[0].answer).toBe("Edited answer.");
    const fetched = await repo.getById(inserted.id, BOOTSTRAP_ADMIN_ID);
    expect(fetched?.answers[0].answer).toBe("Edited answer.");
  });

  it("update() returns null for an unknown id", async () => {
    const db = await createTestDb();
    const repo = createApplicationAnswersRepo(db);
    const result = await repo.update(crypto.randomUUID(), BOOTSTRAP_ADMIN_ID, [
      { questionId: "q1", prompt: "Why us?", answer: "x", grounding: [] },
    ]);
    expect(result).toBeNull();
  });

  it("update() is scoped by userId — a foreign-owned answers row is untouched (by-uuid PATCH leak fix)", async () => {
    const db = await createTestDb();
    const repo = createApplicationAnswersRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);
    const [userB] = await db
      .insert(users)
      .values({ email: "user-b-answers-update@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();

    const inserted = await repo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      resumeId: resume.id,
      formSource: "pasted",
      answers: [{ questionId: "q1", prompt: "Why us?", answer: "original", grounding: [] }],
      model: "m1",
      costUsd: 0.01,
    });

    const result = await repo.update(inserted.id, userB.id, [
      { questionId: "q1", prompt: "Why us?", answer: "hijacked", grounding: [] },
    ]);
    expect(result).toBeNull();

    const stillOriginal = await repo.getById(inserted.id, BOOTSTRAP_ADMIN_ID);
    expect(stillOriginal?.answers[0].answer).toBe("original");
  });
});
