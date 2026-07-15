import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readAllSseEvents } from "@/app/api/__test-utils__/sse";
import { makeMockLlm } from "@/lib/llm/mock";
import { insertJob, insertJobScore, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { correlationReports, jobScores, jobs, resumes, sources, users } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { ErrorEnvelope } from "@/types";
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

const { POST } = await import("../route");
const { GET } = await import("./route");
const { __resetForTests } = await import("@/server/runs/registry");

function getRequest(id: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost/api/tailor/correlate/${id}`, { headers });
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/tailor/correlate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const CORRELATE_RESULT = {
  rows: [{ id: 0, term: "distributed", status: "met", evidence: "Led distributed payments platform", reason: "r", note: null }],
};

async function seedScoredJob(): Promise<{ jobId: string; resumeId: string }> {
  const source = await insertSource(state.testDb);
  const job = await insertJob(state.testDb, source.id);
  const resume = await insertResume(state.testDb, { isActive: true });
  await insertJobScore(state.testDb, job.id, resume.id, {
    jdFacts: { title: "Backend Engineer", mustHaves: ["distributed"], niceToHaves: [], responsibilities: [], redFlags: [] },
  });
  return { jobId: job.id, resumeId: resume.id };
}

describe("GET /api/tailor/correlate/:id", () => {
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
    const id = crypto.randomUUID();
    const res = await GET(getRequest(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("returns 404 for an unknown report id", async () => {
    const id = "00000000-0000-0000-0000-000000000000";
    const res = await GET(getRequest(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("a malformed (non-uuid) id returns 404 NOT_FOUND, never a 500", async () => {
    const id = "not-a-uuid";
    const res = await GET(getRequest(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("returns a 200 JSON snapshot by default", async () => {
    const { jobId } = await seedScoredJob();
    llm.scripted = { correlate: CORRELATE_RESULT };

    const created = await POST(postRequest({ jobId }));
    const run = await created.json();

    const res = await GET(getRequest(run.id), { params: Promise.resolve({ id: run.id }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = await res.json();
    expect(body.id).toBe(run.id);
    expect(["queued", "running", "completed"]).toContain(body.status);

    const { correlationReportsRepo } = await import("@/server/persistence/repos/correlationReports");
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const row = await correlationReportsRepo.getById(run.id, BOOTSTRAP_ADMIN_ID);
      if (row && (row.status === "completed" || row.status === "failed")) break;
      await new Promise((r) => setTimeout(r, 5));
    }
  });

  it("SSE: emits ordered extract -> classify -> verify -> done", async () => {
    const { jobId } = await seedScoredJob();
    llm.scripted = { correlate: CORRELATE_RESULT };

    const created = await POST(postRequest({ jobId }));
    const run = await created.json();

    const res = await GET(getRequest(run.id, { accept: "text/event-stream" }), { params: Promise.resolve({ id: run.id }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    const events = await readAllSseEvents(res);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.event === "progress" || e.event === "done")).toBe(true);
    // A subscriber attaching after the route's own `await POST(...)` may miss
    // whichever progress events already fired (no event buffering/replay).
    // Whatever subset of stages IS observed here must still be in the
    // canonical order.
    const CANONICAL_STAGES = ["extract", "classify", "verify"];
    const stages = events.filter((e) => e.event === "progress").map((e) => (e.data as { stage: string }).stage);
    const stageIndices = stages.map((s) => CANONICAL_STAGES.indexOf(s));
    expect(stageIndices.every((i) => i >= 0)).toBe(true);
    expect(stageIndices).toEqual([...stageIndices].sort((a, b) => a - b));
    expect(events[events.length - 1].event).toBe("done");

    const doneData = events[events.length - 1].data as { rows: unknown[] };
    expect(Array.isArray(doneData.rows)).toBe(true);

    const ids = events.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("SSE: falls back to a synthetic terminal event when no live handle exists for a completed run", async () => {
    const { jobId } = await seedScoredJob();
    llm.scripted = { correlate: CORRELATE_RESULT };

    const created = await POST(postRequest({ jobId }));
    const run = await created.json();

    const { correlationReportsRepo } = await import("@/server/persistence/repos/correlationReports");
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const row = await correlationReportsRepo.getById(run.id, BOOTSTRAP_ADMIN_ID);
      if (row?.status === "completed") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    __resetForTests();

    const res = await GET(getRequest(run.id, { accept: "text/event-stream" }), { params: Promise.resolve({ id: run.id }) });
    const events = await readAllSseEvents(res);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("done");
  });

  it("SSE: no live handle for a queued/running row closes silently with a retry hint, no error/done event", async () => {
    const { jobId, resumeId } = await seedScoredJob();
    const { createCorrelationReportsRepo } = await import("@/server/persistence/repos/correlationReports");
    const repo = createCorrelationReportsRepo(state.testDb);
    const runningRun = await repo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId,
      resumeId,
      rows: [],
      status: "running",
      model: "test-model",
    });

    const res = await GET(getRequest(runningRun.id, { accept: "text/event-stream" }), {
      params: Promise.resolve({ id: runningRun.id }),
    });
    const text = await res.text();
    expect(text).toContain("retry: 2000");
    expect(text).not.toMatch(/event: (done|error)/);
  });

  it("a failed run streams a terminal error event with an INTERNAL ErrorEnvelope", async () => {
    const { jobId, resumeId } = await seedScoredJob();
    const { createCorrelationReportsRepo } = await import("@/server/persistence/repos/correlationReports");
    const repo = createCorrelationReportsRepo(state.testDb);
    const failedRun = await repo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId,
      resumeId,
      rows: [],
      status: "failed",
      model: "test-model",
    });

    const res = await GET(getRequest(failedRun.id, { accept: "text/event-stream" }), {
      params: Promise.resolve({ id: failedRun.id }),
    });
    const events = await readAllSseEvents(res);
    const last = events[events.length - 1];
    expect(last.event).toBe("error");
    const parsed = ErrorEnvelope.parse(last.data);
    expect(parsed.error.code).toBe("INTERNAL");
  });

  it("SSE ownership (Fable design review): B cannot open A's correlation report stream — 404 before the run handle is ever touched", async () => {
    const { jobId, resumeId } = await seedScoredJob();
    const { createCorrelationReportsRepo } = await import("@/server/persistence/repos/correlationReports");
    const repo = createCorrelationReportsRepo(state.testDb);
    const runA = await repo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId,
      resumeId,
      rows: [],
      status: "running",
      model: "test-model",
    });
    const [userB] = await state.testDb
      .insert(users)
      .values({ email: "user-b-correlate-sse@example.com", passwordHash: "h", role: "user" })
      .returning();

    requireUser.mockResolvedValue({ id: userB.id, email: userB.email, role: "user" });

    const jsonRes = await GET(getRequest(runA.id), { params: Promise.resolve({ id: runA.id }) });
    expect(jsonRes.status).toBe(404);
    expect((await jsonRes.json()).error.code).toBe("NOT_FOUND");

    const sseRes = await GET(getRequest(runA.id, { accept: "text/event-stream" }), { params: Promise.resolve({ id: runA.id }) });
    expect(sseRes.status).toBe(404);
    expect((await sseRes.json()).error.code).toBe("NOT_FOUND");
  });
});
