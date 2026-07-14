import { NextRequest } from "next/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { insertJob, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { applicationAnswersRepo } from "@/server/persistence/repos/applicationAnswers";
import { applicationAnswers, jobs, resumes, sources } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { PATCH } = await import("./route");

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/apply/answers/x", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("PATCH /api/apply/answers/:id", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  afterEach(async () => {
    await state.testDb.delete(applicationAnswers);
    await state.testDb.delete(jobs);
    await state.testDb.delete(resumes);
    await state.testDb.delete(sources);
  });

  it("empty answers[] -> 422 VALIDATION_ERROR", async () => {
    const res = await PATCH(jsonRequest({ answers: [] }), params(crypto.randomUUID()));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("unknown id -> 404 NOT_FOUND", async () => {
    const res = await PATCH(
      jsonRequest({ answers: [{ questionId: "q1", prompt: "x", answer: "y", grounding: [] }] }),
      params(crypto.randomUUID()),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("a malformed (non-uuid) id returns 404 NOT_FOUND, never a 500", async () => {
    const res = await PATCH(
      jsonRequest({ answers: [{ questionId: "q1", prompt: "x", answer: "y", grounding: [] }] }),
      params("not-a-uuid"),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("happy path -> 200 with the replaced answer set", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true });
    const inserted = await applicationAnswersRepo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      resumeId: resume.id,
      formSource: "pasted",
      answers: [{ questionId: "q1", prompt: "Why us?", answer: "original", grounding: [] }],
      model: "m1",
      costUsd: 0.01,
    });

    const res = await PATCH(
      jsonRequest({
        answers: [{ questionId: "q1", prompt: "Why us?", answer: "edited by candidate", grounding: [{ source: "skills", quote: "TypeScript" }] }],
      }),
      params(inserted.id),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.answers[0].answer).toBe("edited by candidate");
  });

  it("invalid JSON body -> 422 VALIDATION_ERROR", async () => {
    const req = new NextRequest("http://localhost/api/apply/answers/x", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await PATCH(req, params(crypto.randomUUID()));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });
});
