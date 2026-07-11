import { NextRequest } from "next/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readAllSseEvents } from "@/app/api/__test-utils__/sse";
import { insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import type { SourceRow } from "@/server/persistence/repos/sources";
import { jobs, resumes, searchRuns, sources } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import type { RawPosting, SourceConnector } from "@/server/search/connector";
import { ErrorEnvelope } from "@/types";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb, hang: false }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

function stubConnector(source: SourceRow): SourceConnector {
  return {
    id: source.id,
    kind: source.kind,
    persona: source.persona,
    async *discover(ctx) {
      const postings: RawPosting[] = [];
      if (state.hang) {
        if (ctx.signal.aborted) throw new Error("aborted");
        await new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      for (const p of postings) yield p;
    },
  };
}
vi.mock("@/server/search/connectors", () => ({ connectorForSource: (source: SourceRow) => stubConnector(source) }));

const { POST } = await import("../route");
const { GET } = await import("./route");
const { __resetForTests, get: getRunHandle } = await import("@/server/runs/registry");

function getRequest(id: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost/api/search/${id}`, { headers });
}

describe("GET /api/search/:id", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  afterEach(async () => {
    state.hang = false;
    __resetForTests();
    await state.testDb.delete(jobs);
    await state.testDb.delete(searchRuns);
    await state.testDb.delete(sources);
    await state.testDb.delete(resumes);
  });

  it("returns 404 for an unknown run id", async () => {
    const res = await GET(getRequest("00000000-0000-0000-0000-000000000000"), {
      params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("returns a 200 JSON snapshot by default (no Accept header)", async () => {
    await insertResume(state.testDb, { isActive: true });
    await insertSource(state.testDb, { id: "greenhouse", kind: "ats", persona: "remote" });

    const created = await POST(
      new NextRequest("http://localhost/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ persona: "remote" }),
      }),
    );
    const run = await created.json();

    const res = await GET(getRequest(run.id), { params: Promise.resolve({ id: run.id }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = await res.json();
    expect(body.id).toBe(run.id);
    expect(["queued", "running", "completed"]).toContain(body.status);
  });

  it("SSE: emits ordered progress…done events and never a job event", async () => {
    await insertResume(state.testDb, { isActive: true });
    await insertSource(state.testDb, { id: "greenhouse", kind: "ats", persona: "remote" });
    state.hang = false; // connector completes quickly (no postings)

    const created = await POST(
      new NextRequest("http://localhost/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ persona: "remote" }),
      }),
    );
    const run = await created.json();

    const res = await GET(getRequest(run.id, { accept: "text/event-stream" }), { params: Promise.resolve({ id: run.id }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    const events = await readAllSseEvents(res);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.event === "progress" || e.event === "done")).toBe(true);
    expect(events.some((e) => e.event === "job")).toBe(false);
    expect(events[events.length - 1].event).toBe("done");

    const ids = events.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("SSE: falls back to a synthetic terminal event when no live handle exists for a completed run", async () => {
    await insertResume(state.testDb, { isActive: true });
    await insertSource(state.testDb, { id: "greenhouse", kind: "ats", persona: "remote" });

    const created = await POST(
      new NextRequest("http://localhost/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ persona: "remote" }),
      }),
    );
    const run = await created.json();

    // Wait for the run to actually complete, then simulate the handle being
    // gone (process restart / eviction) by resetting the in-memory registry
    // while leaving the DB row intact.
    const repo = (await import("@/server/persistence/repos/searchRuns")).createSearchRunsRepo(state.testDb);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const row = await repo.getById(run.id);
      if (row?.status === "completed") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    __resetForTests();
    expect(getRunHandle(run.id)).toBeUndefined();

    const res = await GET(getRequest(run.id, { accept: "text/event-stream" }), { params: Promise.resolve({ id: run.id }) });
    const events = await readAllSseEvents(res);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("done");
  });

  it("a failed run streams a terminal error event with an INTERNAL ErrorEnvelope", async () => {
    const resume = await insertResume(state.testDb, { isActive: true });
    const repo = (await import("@/server/persistence/repos/searchRuns")).createSearchRunsRepo(state.testDb);
    const failedRun = await repo.insert({
      resumeId: resume.id,
      personas: ["remote"],
      status: "failed",
      stats: { scanned: 0, matched: 0, scored: 0, worth: 0, ghosts: 0, perSource: [], unscored: 0, capStopped: false },
      error: "Simulated crash.",
      finishedAt: new Date(),
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
