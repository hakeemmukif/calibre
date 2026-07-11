import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeMockLlm } from "@/lib/llm/mock";
import { insertJob, insertJobScore, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { jobs, jobScores, resumes, sources } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const domParse = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("./dom-parse", () => ({ parseFormViaDom: domParse.fn }));

const llm = vi.hoisted(() => ({ scripted: {} as Record<string, unknown> }));
vi.mock("@/lib/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/client")>();
  return { ...actual, getLlm: () => makeMockLlm(llm.scripted) };
});

const { extractQuestions, UnknownJobError, ExtractionFailedError } = await import("./extract-questions");

describe("extractQuestions", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  afterEach(async () => {
    domParse.fn.mockReset();
    llm.scripted = {};
    vi.unstubAllGlobals();
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(sources);
    await state.testDb.delete(resumes);
  });

  it("tier 3 (paste): happy path returns questions with sourceUrl null", async () => {
    llm.scripted = {
      "question-extract": {
        questions: [{ id: "q1", prompt: "Why do you want to work here?", kind: "textarea", required: true }],
      },
    };

    const result = await extractQuestions({ pastedForm: "Why do you want to work here? ____" });

    expect(result.sourceUrl).toBeNull();
    expect(result.questions).toEqual([{ id: "q1", prompt: "Why do you want to work here?", kind: "textarea", required: true }]);
  });

  it("tier 3 (paste): no questions found -> ExtractionFailedError, never []", async () => {
    llm.scripted = { "question-extract": { questions: [] } };
    await expect(extractQuestions({ pastedForm: "blank form" })).rejects.toBeInstanceOf(ExtractionFailedError);
  });

  it("unknown jobId -> UnknownJobError", async () => {
    await expect(extractQuestions({ jobId: crypto.randomUUID() })).rejects.toBeInstanceOf(UnknownJobError);
  });

  it("tier 1 (Greenhouse): maps a stubbed API fixture and never calls tier 2", async () => {
    const source = await insertSource(state.testDb, { id: "greenhouse", kind: "ats", config: { slug: "acme" } });
    const job = await insertJob(state.testDb, source.id, {
      sourceId: "greenhouse",
      externalId: "123456",
      url: "https://boards.greenhouse.io/acme/jobs/123456",
      applyUrl: "https://boards.greenhouse.io/acme/jobs/123456",
    });
    const resume = await insertResume(state.testDb);
    await insertJobScore(state.testDb, job.id, resume.id);

    const fixture = {
      questions: [
        { label: "Why do you want to work here?", required: true, fields: [{ name: "value", type: "textarea" }] },
        {
          label: "How did you hear about us?",
          required: false,
          fields: [{ name: "value", type: "multi_value_single_select", values: [{ label: "LinkedIn" }, { label: "Referral" }] }],
        },
      ],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

    const result = await extractQuestions({ jobId: job.id });

    expect(result.sourceUrl).toBe("https://boards.greenhouse.io/acme/jobs/123456");
    expect(result.questions.map((q) => q.kind)).toEqual(["textarea", "select"]);
    expect(domParse.fn).not.toHaveBeenCalled();
  });

  it("both tiers empty -> ExtractionFailedError, never []", async () => {
    const source = await insertSource(state.testDb, { id: "greenhouse", kind: "ats", config: { slug: "acme" } });
    const job = await insertJob(state.testDb, source.id, {
      sourceId: "greenhouse",
      externalId: "999",
      url: "https://boards.greenhouse.io/acme/jobs/999",
      applyUrl: "https://boards.greenhouse.io/acme/jobs/999",
    });
    const resume = await insertResume(state.testDb);
    await insertJobScore(state.testDb, job.id, resume.id);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ questions: [] }), { status: 200 })));
    domParse.fn.mockResolvedValue(null);

    await expect(extractQuestions({ jobId: job.id })).rejects.toBeInstanceOf(ExtractionFailedError);
  });

  it("falls through to tier 2 for a non-Greenhouse source, using the raw url path when domParse succeeds", async () => {
    const source = await insertSource(state.testDb, { id: "lever", kind: "ats", config: {} });
    const job = await insertJob(state.testDb, source.id, {
      sourceId: "lever",
      url: "https://jobs.lever.co/acme/xyz",
      applyUrl: "https://jobs.lever.co/acme/xyz",
    });
    const resume = await insertResume(state.testDb);
    await insertJobScore(state.testDb, job.id, resume.id);

    domParse.fn.mockResolvedValue([{ label: "Cover letter", field_type: "textarea", required: false }]);

    const result = await extractQuestions({ jobId: job.id });

    expect(result.sourceUrl).toBe("https://jobs.lever.co/acme/xyz");
    expect(result.questions).toEqual([{ id: "q-0-cover-letter", prompt: "Cover letter", kind: "textarea", required: false }]);
  });

  it("url-only input skips tier 1 entirely and goes straight to tier 2", async () => {
    domParse.fn.mockResolvedValue([{ label: "Name", field_type: "text", required: true }]);

    const result = await extractQuestions({ url: "https://example.com/careers/apply" });

    expect(result.sourceUrl).toBe("https://example.com/careers/apply");
    expect(domParse.fn).toHaveBeenCalledWith("https://example.com/careers/apply");
    expect(result.questions).toHaveLength(1);
  });
});
