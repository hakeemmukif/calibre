import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { insertJob, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { applicationAnswersRepo } from "@/server/persistence/repos/applicationAnswers";
import { applicationAnswers, jobs, resumes, sources, users } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";
import { UnauthorizedError } from "@/server/auth/errors";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { requireUser } = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/server/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/server/auth/session")>()),
  requireUser: () => requireUser(),
}));

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

  beforeEach(() => {
    requireUser.mockReset();
    requireUser.mockResolvedValue({ id: BOOTSTRAP_ADMIN_ID, email: "admin@example.com", role: "admin" });
  });

  afterEach(async () => {
    await state.testDb.delete(applicationAnswers);
    await state.testDb.delete(jobs);
    await state.testDb.delete(resumes);
    await state.testDb.delete(sources);
  });

  it("401s with UNAUTHORIZED when there is no session", async () => {
    requireUser.mockRejectedValue(new UnauthorizedError());
    const res = await PATCH(
      jsonRequest({ answers: [{ questionId: "q1", prompt: "x", answer: "y", grounding: [] }] }),
      params(crypto.randomUUID()),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
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

  it("by-uuid PATCH leak fix (Fable design review, CRITICAL): B cannot PATCH A's drafted answers — 404, row unchanged", async () => {
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

    const [userB] = await state.testDb
      .insert(users)
      .values({ email: "user-b-apply-answers-patch@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    requireUser.mockResolvedValue({ id: userB.id, email: userB.email, role: "user" });

    const res = await PATCH(
      jsonRequest({ answers: [{ questionId: "q1", prompt: "Why us?", answer: "hijacked", grounding: [] }] }),
      params(inserted.id),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");

    const stillOriginal = await applicationAnswersRepo.getById(inserted.id, BOOTSTRAP_ADMIN_ID);
    expect(stillOriginal?.answers[0].answer).toBe("original");
  });
});
