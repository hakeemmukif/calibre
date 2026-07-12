import { NextRequest } from "next/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readAllSseEvents } from "@/app/api/__test-utils__/sse";
import { makeMockLlm } from "@/lib/llm/mock";
import { insertJob, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { jobs, resumes, sources, tailoredResumes } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { ErrorEnvelope } from "@/types";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const llm = vi.hoisted(() => ({ scripted: {} as Record<string, unknown> }));
vi.mock("@/lib/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/client")>();
  return { ...actual, getLlm: () => makeMockLlm(llm.scripted) };
});

const { POST } = await import("../route");
const { GET } = await import("./route");
const { __resetForTests } = await import("@/server/runs/registry");

function getRequest(id: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost/api/tailor/${id}`, { headers });
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/tailor", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const TAILOR_RESULT = {
  resume: {
    name: "Jane Doe",
    contact: [
      { label: "email", value: "jane@example.com" },
      { label: "location", value: "Kuala Lumpur, Malaysia" },
      { label: "headline", value: "Backend Engineer" },
    ],
    summary: "Tailored summary.",
    experience: [],
    education: [],
    skills: [],
    extras: [],
  },
  diff: [],
};

describe("GET /api/tailor/:id", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  afterEach(async () => {
    llm.scripted = {};
    __resetForTests();
    await state.testDb.delete(tailoredResumes);
    await state.testDb.delete(jobs);
    await state.testDb.delete(resumes);
    await state.testDb.delete(sources);
  });

  it("returns 404 for an unknown run id", async () => {
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
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    await insertResume(state.testDb, { isActive: true });
    llm.scripted = { tailor: TAILOR_RESULT };

    const created = await POST(postRequest({ jobId: job.id }));
    const run = await created.json();

    const res = await GET(getRequest(run.id), { params: Promise.resolve({ id: run.id }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = await res.json();
    expect(body.id).toBe(run.id);
    expect(["queued", "running", "completed"]).toContain(body.status);

    const { tailoredResumesRepo } = await import("@/server/persistence/repos/tailoredResumes");
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const row = await tailoredResumesRepo.getById(run.id);
      if (row && (row.status === "completed" || row.status === "failed")) break;
      await new Promise((r) => setTimeout(r, 5));
    }
  });

  it("SSE: emits ordered analyze -> rewrite -> render -> done", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    await insertResume(state.testDb, { isActive: true });
    llm.scripted = { tailor: TAILOR_RESULT };

    const created = await POST(postRequest({ jobId: job.id }));
    const run = await created.json();

    const res = await GET(getRequest(run.id, { accept: "text/event-stream" }), { params: Promise.resolve({ id: run.id }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    const events = await readAllSseEvents(res);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.event === "progress" || e.event === "done")).toBe(true);
    // A subscriber attaching after the route's own `await POST(...)` may miss
    // whichever progress events already fired (no event buffering/replay —
    // server/tailor/tailor.test.ts asserts the full analyze->rewrite->render
    // order by subscribing synchronously right after startTailor resolves,
    // which this route-boundary test can't guarantee). Whatever subset of
    // stages IS observed here must still be in the canonical order.
    const CANONICAL_STAGES = ["analyze", "rewrite", "render"];
    const stages = events.filter((e) => e.event === "progress").map((e) => (e.data as { stage: string }).stage);
    const stageIndices = stages.map((s) => CANONICAL_STAGES.indexOf(s));
    expect(stageIndices.every((i) => i >= 0)).toBe(true);
    expect(stageIndices).toEqual([...stageIndices].sort((a, b) => a - b));
    expect(events[events.length - 1].event).toBe("done");

    const doneData = events[events.length - 1].data as { resume: unknown; diff: unknown[] };
    expect(doneData.resume).not.toBeNull();

    const ids = events.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("SSE: falls back to a synthetic terminal event when no live handle exists for a completed run", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    await insertResume(state.testDb, { isActive: true });
    llm.scripted = { tailor: TAILOR_RESULT };

    const created = await POST(postRequest({ jobId: job.id }));
    const run = await created.json();

    const { tailoredResumesRepo } = await import("@/server/persistence/repos/tailoredResumes");
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const row = await tailoredResumesRepo.getById(run.id);
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
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true });
    const { createTailoredResumesRepo } = await import("@/server/persistence/repos/tailoredResumes");
    const repo = createTailoredResumesRepo(state.testDb);
    const runningRun = await repo.insert({
      jobId: job.id,
      baseResumeId: resume.id,
      diff: [],
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
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true });
    const { createTailoredResumesRepo } = await import("@/server/persistence/repos/tailoredResumes");
    const repo = createTailoredResumesRepo(state.testDb);
    const failedRun = await repo.insert({
      jobId: job.id,
      baseResumeId: resume.id,
      diff: [],
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
});
