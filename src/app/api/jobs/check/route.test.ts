import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMockLlm } from "@/lib/llm/mock";
import { UnauthorizedError } from "@/server/auth/errors";
import {
  insertJob,
  insertJobScore,
  insertProfile,
  insertResume,
  insertSource,
} from "@/server/persistence/repos/__fixtures__/helpers";
import { jobs, jobScores, resumes, sources, urlChecks, users } from "@/server/persistence/schema";
import { dedupeKeyFor } from "@/server/search/dedupe";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { requireUser } = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/server/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/server/auth/session")>()),
  requireUser: () => requireUser(),
}));

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
vi.mock("@/server/url-check/worker", () => ({
  urlCheckWorker: { kick: vi.fn().mockResolvedValue(undefined), isPaused: vi.fn().mockReturnValue(false) },
}));

const { POST, GET } = await import("./route");

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/jobs/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function newUrlCheckRow(overrides: Partial<typeof urlChecks.$inferInsert> = {}) {
  const url = overrides.url ?? `https://example.com/job/${crypto.randomUUID()}`;
  return {
    id: crypto.randomUUID(),
    userId: BOOTSTRAP_ADMIN_ID,
    url,
    dedupeKey: url,
    status: "queued" as const,
    stage: null,
    jobId: null,
    alreadyKnown: false,
    needsText: false,
    error: null,
    costUsd: 0,
    raw: { text: null },
    ...overrides,
  };
}

describe("POST /api/jobs/check", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  beforeEach(() => {
    requireUser.mockReset();
    requireUser.mockResolvedValue({ id: BOOTSTRAP_ADMIN_ID, email: "admin@example.com", role: "admin" });
  });

  afterEach(async () => {
    llm.scripted = {};
    await state.testDb.delete(urlChecks);
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(sources);
    await state.testDb.delete(resumes);
  });

  it("401s with UNAUTHORIZED when there is no session", async () => {
    requireUser.mockRejectedValue(new UnauthorizedError());
    const res = await POST(jsonRequest({ url: "https://example.com/job/1" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
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

describe("GET /api/jobs/check", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  beforeEach(() => {
    requireUser.mockReset();
    requireUser.mockResolvedValue({ id: BOOTSTRAP_ADMIN_ID, email: "admin@example.com", role: "admin" });
  });

  afterEach(async () => {
    await state.testDb.delete(urlChecks);
  });

  it("401s with UNAUTHORIZED when there is no session", async () => {
    requireUser.mockRejectedValue(new UnauthorizedError());
    const res = await GET(new NextRequest("http://localhost/api/jobs/check?active=1"));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("?active=1 returns queued and running rows only", async () => {
    const [queued] = await state.testDb.insert(urlChecks).values(newUrlCheckRow({ status: "queued" })).returning();
    const [running] = await state.testDb.insert(urlChecks).values(newUrlCheckRow({ status: "running" })).returning();
    await state.testDb.insert(urlChecks).values(newUrlCheckRow({ status: "completed" })).returning();
    await state.testDb.insert(urlChecks).values(newUrlCheckRow({ status: "failed" })).returning();

    const res = await GET(new NextRequest("http://localhost/api/jobs/check?active=1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.paused).toBe(false);
    expect(body.checks.map((c: { id: string }) => c.id).sort()).toEqual([queued.id, running.id].sort());
  });

  it("?active=1 returns only the caller's own checks (cross-tenant isolation)", async () => {
    const [userB] = await state.testDb
      .insert(users)
      .values({ email: `user-b-jobs-check-route-${crypto.randomUUID()}@example.com`, passwordHash: "h", role: "user" })
      .returning();
    const [checkA] = await state.testDb.insert(urlChecks).values(newUrlCheckRow({ status: "queued" })).returning();
    const [checkB] = await state.testDb
      .insert(urlChecks)
      .values(newUrlCheckRow({ status: "queued", userId: userB.id }))
      .returning();

    requireUser.mockResolvedValue({ id: userB.id, email: userB.email, role: "user" });
    const res = await GET(new NextRequest("http://localhost/api/jobs/check?active=1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checks.map((c: { id: string }) => c.id)).toEqual([checkB.id]);
    expect(body.checks.map((c: { id: string }) => c.id)).not.toContain(checkA.id);
  });

  it("?ids=a,b returns exactly those rows", async () => {
    const [a] = await state.testDb.insert(urlChecks).values(newUrlCheckRow()).returning();
    const [b] = await state.testDb.insert(urlChecks).values(newUrlCheckRow()).returning();
    await state.testDb.insert(urlChecks).values(newUrlCheckRow()).returning();

    const res = await GET(new NextRequest(`http://localhost/api/jobs/check?ids=${a.id},${b.id}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checks.map((c: { id: string }) => c.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("neither param → 422", async () => {
    const res = await GET(new NextRequest("http://localhost/api/jobs/check"));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("reports paused:true from the worker singleton", async () => {
    const { urlCheckWorker } = await import("@/server/url-check/worker");
    (urlCheckWorker.isPaused as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);

    const res = await GET(new NextRequest("http://localhost/api/jobs/check?active=1"));
    const body = await res.json();
    expect(body.paused).toBe(true);
  });
});
