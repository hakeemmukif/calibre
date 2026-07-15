import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMockLlm } from "@/lib/llm/mock";
import { insertJob, insertJobScore, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { correlationReports, jobScores, jobs, resumes, sources } from "@/server/persistence/schema";
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

const llm = vi.hoisted(() => ({ scripted: {} as Record<string, unknown> }));
vi.mock("@/lib/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/client")>();
  return { ...actual, getLlm: () => makeMockLlm(llm.scripted) };
});

const { POST } = await import("./route");
const { __resetForTests } = await import("@/server/runs/registry");

async function waitForTerminal(id: string, timeoutMs = 2000): Promise<void> {
  const { correlationReportsRepo } = await import("@/server/persistence/repos/correlationReports");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await correlationReportsRepo.getById(id, BOOTSTRAP_ADMIN_ID);
    if (row && (row.status === "completed" || row.status === "failed")) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`correlate run ${id} did not reach a terminal state within the test timeout`);
}

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/tailor/correlate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/tailor/correlate", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  beforeEach(() => {
    requireUser.mockReset();
    requireUser.mockResolvedValue({ id: BOOTSTRAP_ADMIN_ID, email: "admin@example.com", role: "admin" });
  });

  afterEach(async () => {
    llm.scripted = {};
    __resetForTests();
    await state.testDb.delete(correlationReports);
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(resumes);
    await state.testDb.delete(sources);
  });

  it("401s with UNAUTHORIZED when there is no session", async () => {
    requireUser.mockRejectedValue(new UnauthorizedError());
    const res = await POST(jsonRequest({ jobId: crypto.randomUUID() }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("unknown jobId -> 404 NOT_FOUND", async () => {
    const res = await POST(jsonRequest({ jobId: crypto.randomUUID() }));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("no résumé -> 409 CONFLICT", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);

    const res = await POST(jsonRequest({ jobId: job.id }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
  });

  it("no jd facts (job never scored) -> 409 CONFLICT", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    await insertResume(state.testDb, { isActive: true });

    const res = await POST(jsonRequest({ jobId: job.id }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
  });

  it("happy path -> 202 with a queued CorrelationReport", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true });
    await insertJobScore(state.testDb, job.id, resume.id, {
      jdFacts: { title: "Backend Engineer", mustHaves: ["distributed"], niceToHaves: [], responsibilities: [], redFlags: [] },
    });

    llm.scripted = {
      correlate: {
        rows: [{ id: 0, term: "distributed", status: "met", evidence: "Led distributed payments platform", reason: "r", note: null }],
      },
    };

    const res = await POST(jsonRequest({ jobId: job.id }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe("queued");
    expect(body.jobId).toBe(job.id);
    expect(body.rows).toEqual([]);

    await waitForTerminal(body.id);
  });

  it("invalid JSON body -> 422 VALIDATION_ERROR", async () => {
    const req = new NextRequest("http://localhost/api/tailor/correlate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("missing jobId -> 422 VALIDATION_ERROR", async () => {
    const res = await POST(jsonRequest({}));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("non-uuid jobId -> 422 VALIDATION_ERROR, never a 500", async () => {
    const res = await POST(jsonRequest({ jobId: "not-a-uuid" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });
});
