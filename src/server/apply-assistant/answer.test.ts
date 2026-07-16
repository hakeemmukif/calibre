import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LlmClient } from "@/lib/llm/client";
import { makeMockLlm } from "@/lib/llm/mock";
import { balance, grant, InsufficientCreditsError } from "@/server/credits";
import { insertJob, insertJobScore, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { applicationAnswers, creditLedger, jobs, jobScores, resumes, sources, users } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { applicationAnswersRepo } from "@/server/persistence/repos/applicationAnswers";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

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
        BOOTSTRAP_ADMIN_ID,
        { jobId: crypto.randomUUID(), questions: [{ id: "q1", prompt: "Why us?", kind: "text", required: true }] },
        { llm: makeMockLlm({}) },
      ),
    ).rejects.toBeInstanceOf(UnknownJobError);
  });

  it("a foreign-owned jobId -> UnknownJobError (no existence leak)", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const [userB] = await state.testDb
      .insert(users)
      .values({ email: "user-b-draft-answers@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();

    await expect(
      draftAnswers(
        userB.id,
        { jobId: job.id, questions: [{ id: "q1", prompt: "Why us?", kind: "text", required: true }] },
        { llm: makeMockLlm({}) },
      ),
    ).rejects.toBeInstanceOf(UnknownJobError);
  });

  it("no active résumé -> NoActiveResumeError", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);

    await expect(
      draftAnswers(
        BOOTSTRAP_ADMIN_ID,
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
        BOOTSTRAP_ADMIN_ID,
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

    await draftAnswers(BOOTSTRAP_ADMIN_ID, { jobId: job.id, questions: [{ id: "q1", prompt: "x", kind: "text", required: true }] }, { llm });

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
      draftAnswers(BOOTSTRAP_ADMIN_ID, { jobId: job.id, questions: [{ id: "q1", prompt: "x", kind: "text", required: true }] }, { llm: failingLlm }),
    ).rejects.toBeInstanceOf(UpstreamLlmError);
  });
});

// Membership-credits Task 7: draftAnswers debits 1 credit per question
// (units = questions.length), at admission, before the LLM call.
// BOOTSTRAP_ADMIN_ID (used throughout the suite above) is admin/unlimited
// and bypasses credits entirely, so these need their own non-admin,
// standard-plan users to actually exercise the ledger.
describe("draftAnswers — credit debit", () => {
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

  async function seedUser(): Promise<string> {
    const id = crypto.randomUUID();
    await state.testDb.insert(users).values({ id, email: `${id}@example.com`, passwordHash: "h", role: "user", plan: "standard" });
    return id;
  }

  it("debits units = questions.length (3 questions -> 3), no refId", async () => {
    const userId = await seedUser();
    await grant(userId, 3, "admin");
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { userId });
    await insertResume(state.testDb, { userId, isActive: true });

    const llm = makeMockLlm({
      "question-answer": {
        answers: [
          { questionId: "q1", prompt: "a", answer: "x", grounding: [] },
          { questionId: "q2", prompt: "b", answer: "y", grounding: [] },
          { questionId: "q3", prompt: "c", answer: "z", grounding: [] },
        ],
      },
    });

    await draftAnswers(
      userId,
      {
        jobId: job.id,
        questions: [
          { id: "q1", prompt: "a", kind: "text", required: true },
          { id: "q2", prompt: "b", kind: "text", required: true },
          { id: "q3", prompt: "c", kind: "text", required: true },
        ],
      },
      { llm },
    );

    expect(await balance(userId)).toBe(0);
    const rows = await state.testDb.select().from(creditLedger).where(eq(creditLedger.userId, userId));
    const debitRow = rows.find((r) => r.reason === "debit");
    expect(debitRow?.delta).toBe(-3);
    expect(debitRow?.feature).toBe("answers");
    expect(debitRow?.refId).toBeNull();
  });

  it("insufficient credits -> InsufficientCreditsError before the LLM call; no applicationAnswers row inserted", async () => {
    const userId = await seedUser();
    await grant(userId, 2, "admin"); // needs 3 (one per question)
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { userId });
    await insertResume(state.testDb, { userId, isActive: true });

    const complete = vi.fn();
    const llm = { complete } as unknown as LlmClient;

    await expect(
      draftAnswers(
        userId,
        {
          jobId: job.id,
          questions: [
            { id: "q1", prompt: "a", kind: "text", required: true },
            { id: "q2", prompt: "b", kind: "text", required: true },
            { id: "q3", prompt: "c", kind: "text", required: true },
          ],
        },
        { llm },
      ),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    expect(complete).not.toHaveBeenCalled();
    expect(await balance(userId)).toBe(2);
    const persisted = await state.testDb.select().from(applicationAnswers).where(eq(applicationAnswers.jobId, job.id));
    expect(persisted).toHaveLength(0);
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
    const drafted = await draftAnswers(BOOTSTRAP_ADMIN_ID, { jobId: job.id, questions: [{ id: "q1", prompt: "x", kind: "text", required: true }] }, { llm });

    const patched = await patchAnswers(drafted.id, BOOTSTRAP_ADMIN_ID, [
      { questionId: "q1", prompt: "x", answer: "edited by candidate", grounding: [{ source: "skills", quote: "TypeScript" }] },
    ]);

    expect(patched.id).toBe(drafted.id);
    expect(patched.resumeId).toBe(resume.id);
    expect(patched.answers[0].answer).toBe("edited by candidate");
  });

  it("unknown id -> UnknownAnswersIdError", async () => {
    await expect(
      patchAnswers(crypto.randomUUID(), BOOTSTRAP_ADMIN_ID, [{ questionId: "q1", prompt: "x", answer: "y", grounding: [] }]),
    ).rejects.toBeInstanceOf(UnknownAnswersIdError);
  });

  it("is scoped by userId — a foreign-owned answers row throws UnknownAnswersIdError, row unchanged (by-uuid PATCH leak fix)", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    await insertResume(state.testDb, { isActive: true });

    const llm = makeMockLlm({
      "question-answer": { answers: [{ questionId: "q1", prompt: "x", answer: "original", grounding: [] }] },
    });
    const drafted = await draftAnswers(
      BOOTSTRAP_ADMIN_ID,
      { jobId: job.id, questions: [{ id: "q1", prompt: "x", kind: "text", required: true }] },
      { llm },
    );

    const [userB] = await state.testDb
      .insert(users)
      .values({ email: "user-b-answer-patch@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();

    await expect(
      patchAnswers(drafted.id, userB.id, [{ questionId: "q1", prompt: "x", answer: "hijacked", grounding: [] }]),
    ).rejects.toBeInstanceOf(UnknownAnswersIdError);

    const stillOriginal = await applicationAnswersRepo.getById(drafted.id, BOOTSTRAP_ADMIN_ID);
    expect(stillOriginal?.answers[0].answer).toBe("original");
  });
});
