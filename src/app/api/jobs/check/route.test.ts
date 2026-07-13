import { NextRequest } from "next/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeMockLlm } from "@/lib/llm/mock";
import {
  insertJob,
  insertJobScore,
  insertProfile,
  insertResume,
  insertSource,
} from "@/server/persistence/repos/__fixtures__/helpers";
import { jobs, jobScores, resumes, sources, urlChecks } from "@/server/persistence/schema";
import { dedupeKeyFor } from "@/server/search/dedupe";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const llm = vi.hoisted(() => ({ scripted: {} as Record<string, unknown> }));
vi.mock("@/lib/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/client")>();
  return { ...actual, getLlm: () => makeMockLlm(llm.scripted) };
});
// startUrlCheck now kicks the boot-started urlCheckWorker singleton instead
// of running the pipeline itself. Without this mock, the "202 queued" test
// below would drain the mocked test DB through the REAL worker with REAL
// pipeline deps (real fetchPageText/searchForPosting) — hitting the network
// (same hazard the parallel-scoring cutover flags for run.test.ts).
vi.mock("@/server/url-check/worker", () => ({ urlCheckWorker: { kick: vi.fn() } }));

const { POST } = await import("./route");

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/jobs/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/jobs/check", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  afterEach(async () => {
    llm.scripted = {};
    await state.testDb.delete(urlChecks);
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(sources);
    await state.testDb.delete(resumes);
  });

  it("no résumé returns 409 CONFLICT before any LLM call", async () => {
    const res = await POST(jsonRequest({ url: "https://example.com/job/1" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
  });

  it("invalid JSON body returns 422 VALIDATION_ERROR", async () => {
    const req = new NextRequest("http://localhost/api/jobs/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("missing url returns 422 VALIDATION_ERROR", async () => {
    await insertResume(state.testDb, { isActive: true });
    const res = await POST(jsonRequest({}));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("pasted text over the 40k-character cap returns 422 PAYLOAD_TOO_LARGE", async () => {
    await insertResume(state.testDb, { isActive: true });
    const res = await POST(jsonRequest({ url: "https://example.com/job/1", text: "a".repeat(40_001) }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("a URL matching an already-known SCORED job short-circuits 200 alreadyKnown", async () => {
    const resume = await insertResume(state.testDb, { isActive: true });
    const source = await insertSource(state.testDb);
    const url = "https://example.com/already-known-job";
    const job = await insertJob(state.testDb, source.id, { url, dedupeKey: dedupeKeyFor(url) });
    // Admission only short-circuits a dedupe hit that already has a score
    // (final review fix wave FIX 1a) — an unscored hit self-heals through
    // the normal pipeline instead (covered at the unit level in run.test.ts).
    await insertJobScore(state.testDb, job.id, resume.id);

    const res = await POST(jsonRequest({ url }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alreadyKnown).toBe(true);
    expect(body.jobId).toBeTruthy();
  });

  it("a new URL starts the pipeline and returns 202 queued", async () => {
    await insertResume(state.testDb, { isActive: true });
    // Profile is no longer read during admission (moved to the worker's
    // claim-time process step, mocked out above) — this insert is now dead
    // weight but harmless; left in place rather than touching more than the
    // worker-mock fix requires.
    await insertProfile(state.testDb);
    const res = await POST(jsonRequest({ url: "https://example.com/brand-new-job" }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe("queued");
    expect(body.alreadyKnown).toBe(false);
  });
});
