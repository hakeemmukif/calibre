import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LlmClient } from "@/lib/llm/client";
import { makeMockLlm } from "@/lib/llm/mock";
import { insertJob, insertJobScore, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { applicationAnswers, jobs, jobScores, resumes, sources } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { draftAnswers, patchAnswers, NoActiveResumeError, UpstreamLlmError, UnknownAnswersIdError, UnknownJobError } = await import(
  "./answer"
);

describe("draftAnswers", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  afterEach(async () => {
    await state.testDb.delete(applicationAnswers);
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(resumes);
    await state.testDb.delete(sources);
  });

  it("unknown jobId -> UnknownJobError, not an FK-violation 500 (regression, fix pass finding 3)", async () => {
    await expect(
      draftAnswers(
        { jobId: crypto.randomUUID(), questions: [{ id: "q1", prompt: "Why us?", kind: "text", required: true }] },
        { llm: makeMockLlm({}) },
      ),
    ).rejects.toBeInstanceOf(UnknownJobError);
  });

  it("no active résumé -> NoActiveResumeError", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);

    await expect(
      draftAnswers(
        { jobId: job.id, questions: [{ id: "q1", prompt: "Why us?", kind: "text", required: true }] },
        { llm: makeMockLlm({}) },
      ),
    ).rejects.toBeInstanceOf(NoActiveResumeError);
  });

  it("grounds each answer and persists a row; an ungrounded answer keeps an empty grounding[] (visible, not dropped)", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true });

    const llm = makeMockLlm({
      "question-answer": {
        answers: [
          {
            questionId: "q1",
            prompt: "Why do you want this role?",
            answer: "Backend engineer with strong overlap.",
            grounding: [{ source: "summary", quote: "Backend engineer." }],
          },
          {
            questionId: "q2",
            prompt: "What's your salary expectation?",
            answer: "",
            grounding: [],
          },
        ],
      },
    });

    const result = await draftAnswers(
      {
        jobId: job.id,
        questions: [
          { id: "q1", prompt: "Why do you want this role?", kind: "textarea", required: true },
          { id: "q2", prompt: "What's your salary expectation?", kind: "text", required: false },
        ],
      },
      { llm },
    );

    expect(result.jobId).toBe(job.id);
    expect(result.resumeId).toBe(resume.id);
    expect(result.answers).toHaveLength(2);
    expect(result.answers[0].grounding).toEqual([{ source: "summary", quote: "Backend engineer." }]);
    expect(result.answers[1].grounding).toEqual([]); // present, empty — never dropped/omitted

    const persisted = await state.testDb.select().from(applicationAnswers);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].answers).toHaveLength(2);
  });

  it("grounds better with the job's latest job_scores JdFacts when the job has been scored", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    await insertResume(state.testDb, { isActive: true });
    await insertJobScore(state.testDb, job.id, (await state.testDb.select().from(resumes))[0].id, {
      jdFacts: { title: "Senior Backend Engineer", mustHaves: ["Node.js"] },
    });

    let capturedMessages: unknown;
    const llm: LlmClient = {
      async complete(args) {
        capturedMessages = args.messages;
        const data = args.responseSchema.parse({
          answers: [{ questionId: "q1", prompt: "x", answer: "y", grounding: [] }],
        });
        return { data, model: "mock", costUsd: 0 };
      },
    };

    await draftAnswers({ jobId: job.id, questions: [{ id: "q1", prompt: "x", kind: "text", required: true }] }, { llm });

    const jdFactsMessage = (capturedMessages as { content: string }[]).find((m) => m.content.includes("Senior Backend Engineer"));
    expect(jdFactsMessage).toBeDefined();
  });

  it("LLM failure -> UpstreamLlmError", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    await insertResume(state.testDb, { isActive: true });

    const failingLlm = {
      async complete(): Promise<never> {
        throw new Error("upstream 500");
      },
    };

    await expect(
      draftAnswers({ jobId: job.id, questions: [{ id: "q1", prompt: "x", kind: "text", required: true }] }, { llm: failingLlm }),
    ).rejects.toBeInstanceOf(UpstreamLlmError);
  });
});

describe("patchAnswers", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  afterEach(async () => {
    await state.testDb.delete(applicationAnswers);
    await state.testDb.delete(jobs);
    await state.testDb.delete(resumes);
    await state.testDb.delete(sources);
  });

  it("replaces the persisted answer set (covers user edits and regenerate)", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true });

    const llm = makeMockLlm({
      "question-answer": { answers: [{ questionId: "q1", prompt: "x", answer: "original", grounding: [] }] },
    });
    const drafted = await draftAnswers({ jobId: job.id, questions: [{ id: "q1", prompt: "x", kind: "text", required: true }] }, { llm });

    const patched = await patchAnswers(drafted.id, [
      { questionId: "q1", prompt: "x", answer: "edited by candidate", grounding: [{ source: "skills", quote: "TypeScript" }] },
    ]);

    expect(patched.id).toBe(drafted.id);
    expect(patched.resumeId).toBe(resume.id);
    expect(patched.answers[0].answer).toBe("edited by candidate");
  });

  it("unknown id -> UnknownAnswersIdError", async () => {
    await expect(
      patchAnswers(crypto.randomUUID(), [{ questionId: "q1", prompt: "x", answer: "y", grounding: [] }]),
    ).rejects.toBeInstanceOf(UnknownAnswersIdError);
  });
});
