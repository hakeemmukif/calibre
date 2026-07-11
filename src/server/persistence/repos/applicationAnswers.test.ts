import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { insertJob, insertResume, insertSource } from "./__fixtures__/helpers";
import { createApplicationAnswersRepo } from "./applicationAnswers";

describe("applicationAnswersRepo", () => {
  it("round-trips insert/getById", async () => {
    const db = await createTestDb();
    const repo = createApplicationAnswersRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);

    const inserted = await repo.insert({
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
    const fetched = await repo.getById(inserted.id);
    expect(fetched?.id).toBe(inserted.id);
    expect(fetched?.answers[0].questionId).toBe("q1");
  });
});
