import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMockLlm } from "@/lib/llm/mock";
import { insertJob, insertJobScore, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { jobs, jobScores, resumes, sources, users } from "@/server/persistence/schema";
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

const domParse = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/server/apply-assistant/dom-parse", () => ({ parseFormViaDom: domParse.fn }));

const llm = vi.hoisted(() => ({ scripted: {} as Record<string, unknown> }));
vi.mock("@/lib/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/client")>();
  return { ...actual, getLlm: () => makeMockLlm(llm.scripted) };
});

const { POST } = await import("./route");

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/apply/questions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/apply/questions", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  beforeEach(() => {
    requireUser.mockReset();
    requireUser.mockResolvedValue({ id: BOOTSTRAP_ADMIN_ID, email: "admin@example.com", role: "admin" });
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

  it("401s with UNAUTHORIZED when there is no session", async () => {
    requireUser.mockRejectedValue(new UnauthorizedError());
    const res = await POST(jsonRequest({ pastedForm: "x" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("a foreign-owned jobId -> 404 NOT_FOUND (cross-tenant isolation)", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const [userB] = await state.testDb
      .insert(users)
      .values({ email: "user-b-apply-questions@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    requireUser.mockResolvedValue({ id: userB.id, email: userB.email, role: "user" });

    const res = await POST(jsonRequest({ jobId: job.id }));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("zero of jobId/url/pastedForm -> 422 VALIDATION_ERROR", async () => {
    const res = await POST(jsonRequest({}));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("two of jobId/url/pastedForm -> 422 VALIDATION_ERROR", async () => {
    const res = await POST(jsonRequest({ jobId: "x", url: "https://example.com" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("exactly-one pastedForm -> 200 with questions and sourceUrl null", async () => {
    llm.scripted = { "question-extract": { questions: [{ id: "q1", prompt: "Why us?", kind: "text", required: true }] } };
    const res = await POST(jsonRequest({ pastedForm: "Why us? ____" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sourceUrl).toBeNull();
    expect(body.questions).toHaveLength(1);
  });

  it("unknown jobId -> 404 NOT_FOUND", async () => {
    const res = await POST(jsonRequest({ jobId: crypto.randomUUID() }));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("non-uuid jobId (exactly-one provided) -> 422 VALIDATION_ERROR, never a 500", async () => {
    const res = await POST(jsonRequest({ jobId: "abc" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("no questions found across both tiers -> 502 EXTRACTION_FAILED (never [])", async () => {
    domParse.fn.mockResolvedValue(null);
    const res = await POST(jsonRequest({ url: "https://example.com/careers/apply" }));
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("EXTRACTION_FAILED");
  });

  it("invalid JSON body -> 422 VALIDATION_ERROR", async () => {
    const req = new NextRequest("http://localhost/api/apply/questions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("happy path via jobId (tier 1 Greenhouse) -> 200", async () => {
    const source = await insertSource(state.testDb, { id: "greenhouse", kind: "ats", config: { slug: "acme", geo: { scope: "restricted" } } });
    const job = await insertJob(state.testDb, source.id, {
      sourceId: "greenhouse",
      externalId: "123456",
      url: "https://boards.greenhouse.io/acme/jobs/123456",
      applyUrl: "https://boards.greenhouse.io/acme/jobs/123456",
    });
    const resume = await insertResume(state.testDb);
    await insertJobScore(state.testDb, job.id, resume.id);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ questions: [{ label: "Why us?", required: true, fields: [{ name: "value", type: "textarea" }] }] }),
          { status: 200 },
        ),
      ),
    );

    const res = await POST(jsonRequest({ jobId: job.id }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sourceUrl).toBe("https://boards.greenhouse.io/acme/jobs/123456");
    expect(body.questions).toHaveLength(1);
  });

  it("tier 3 (paste): schema-invalid LLM reply -> 502 EXTRACTION_FAILED, not 422 (regression, fix pass finding 1)", async () => {
    llm.scripted = { "question-extract": { kind: "long" } };
    const res = await POST(jsonRequest({ pastedForm: "Why us? ____" }));
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("EXTRACTION_FAILED");
  });

  it("tier 1 mapping failure (unrecognized field_type) falls through to tier 2; both empty -> 502, never a raw 500 (regression, fix pass finding 2)", async () => {
    const source = await insertSource(state.testDb, { id: "greenhouse", kind: "ats", config: { slug: "acme", geo: { scope: "restricted" } } });
    const job = await insertJob(state.testDb, source.id, {
      sourceId: "greenhouse",
      externalId: "424242",
      url: "https://boards.greenhouse.io/acme/jobs/424242",
      applyUrl: "https://boards.greenhouse.io/acme/jobs/424242",
    });
    const resume = await insertResume(state.testDb);
    await insertJobScore(state.testDb, job.id, resume.id);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ questions: [{ label: "Mystery field", required: false, fields: [{ name: "value", type: "totally-unknown-type" }] }] }),
          { status: 200 },
        ),
      ),
    );
    domParse.fn.mockResolvedValue(null);

    const res = await POST(jsonRequest({ jobId: job.id }));
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("EXTRACTION_FAILED");
  });
});
