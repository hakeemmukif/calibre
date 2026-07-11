import { NextRequest } from "next/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeMockLlm } from "@/lib/llm/mock";
import { insertJob, insertJobScore, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { jobs, jobScores, resumes, sources } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

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

  afterEach(async () => {
    domParse.fn.mockReset();
    llm.scripted = {};
    vi.unstubAllGlobals();
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(sources);
    await state.testDb.delete(resumes);
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
    const source = await insertSource(state.testDb, { id: "greenhouse", kind: "ats", config: { slug: "acme" } });
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
});
