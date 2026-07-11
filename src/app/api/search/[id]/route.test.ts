import { NextRequest } from "next/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import type { SourceRow } from "@/server/persistence/repos/sources";
import { jobs, resumes, searchRuns, sources } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import type { RawPosting, SourceConnector } from "@/server/search/connector";

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

async function readAllSseEvents(res: Response): Promise<{ id: number; event: string; data: unknown }[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: { id: number; event: string; data: unknown }[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const idLine = chunk.split("\n").find((l) => l.startsWith("id: "));
      const eventLine = chunk.split("\n").find((l) => l.startsWith("event: "));
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (idLine && eventLine && dataLine) {
        events.push({
          id: Number(idLine.slice("id: ".length)),
          event: eventLine.slice("event: ".length),
          data: JSON.parse(dataLine.slice("data: ".length)),
        });
      }
    }
  }
  return events;
}

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
});
