import { NextRequest } from "next/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeMockLlm } from "@/lib/llm/mock";
import { insertJob, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { applicationAnswers, jobs, resumes, sources } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const llm = vi.hoisted(() => ({ scripted: {} as Record<string, unknown> | (() => unknown) }));
vi.mock("@/lib/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/client")>();
  return { ...actual, getLlm: () => makeMockLlm(llm.scripted) };
});

const { POST } = await import("./route");

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/apply/answers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/apply/answers", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  afterEach(async () => {
    llm.scripted = {};
    await state.testDb.delete(applicationAnswers);
    await state.testDb.delete(jobs);
    await state.testDb.delete(resumes);
    await state.testDb.delete(sources);
  });

  it("no résumé -> 409 CONFLICT", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);

    const res = await POST(jsonRequest({ jobId: job.id, questions: [{ id: "q1", prompt: "Why us?", kind: "text", required: true }] }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
  });

  it("happy path -> 200 ApplicationAnswers with grounding", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    await insertResume(state.testDb, { isActive: true });

    llm.scripted = {
      "question-answer": {
        answers: [
          {
            questionId: "q1",
            prompt: "Why us?",
            answer: "Because of the mission.",
            grounding: [{ source: "summary", quote: "Backend engineer." }],
          },
        ],
      },
    };

    const res = await POST(jsonRequest({ jobId: job.id, questions: [{ id: "q1", prompt: "Why us?", kind: "text", required: true }] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.answers[0].grounding).toEqual([{ source: "summary", quote: "Backend engineer." }]);
  });

  it("empty questions[] -> 422 VALIDATION_ERROR", async () => {
    const res = await POST(jsonRequest({ jobId: "some-id", questions: [] }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("LLM failure -> 502 UPSTREAM_LLM_ERROR", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    await insertResume(state.testDb, { isActive: true });

    // makeMockLlm still Zod-validates whatever the scripted fn returns, so an
    // upstream failure has to come from the fn itself throwing, not from a
    // malformed canned payload.
    llm.scripted = () => {
      throw new Error("upstream 500");
    };

    const res = await POST(jsonRequest({ jobId: job.id, questions: [{ id: "q1", prompt: "Why us?", kind: "text", required: true }] }));
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("UPSTREAM_LLM_ERROR");
  });

  it("invalid JSON body -> 422 VALIDATION_ERROR", async () => {
    const req = new NextRequest("http://localhost/api/apply/answers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });
});
