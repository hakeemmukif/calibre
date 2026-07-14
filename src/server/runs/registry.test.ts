import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { insertResume } from "@/server/persistence/repos/__fixtures__/helpers";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { create, get, getActiveRunForPersona, release, markStaleRunningOnBoot, __resetForTests } = await import(
  "./registry"
);
const { createSearchRunsRepo } = await import("@/server/persistence/repos/searchRuns");

describe("run registry", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  afterEach(() => {
    __resetForTests();
  });

  it("create/get round-trips a handle by id", () => {
    const handle = create("search", "run-1");
    expect(get("run-1")).toBe(handle);
    expect(get("unknown")).toBeUndefined();
  });

  it("tracks one active run id per persona and releases it on completion", () => {
    create("search", "run-1", "remote");
    expect(getActiveRunForPersona("remote")).toBe("run-1");

    release("run-1", "remote");
    expect(getActiveRunForPersona("remote")).toBeUndefined();
  });

  it("release is a no-op when the given id no longer owns the persona slot (superseded)", () => {
    create("search", "run-1", "remote");
    create("search", "run-2", "remote"); // run-2 supersedes run-1's slot
    release("run-1", "remote");
    expect(getActiveRunForPersona("remote")).toBe("run-2");
  });

  it("emit() delivers events in order with monotonically increasing ids, and marks terminal state", () => {
    const handle = create("search", "run-1");
    const received: Array<{ event: string; id: number }> = [];
    handle.subscribe((event, id) => received.push({ event: event.event, id }));

    expect(handle.isTerminal).toBe(false);
    handle.emit({ event: "progress", data: { stage: "sources", current: 1, total: 2, label: "x" } });
    handle.emit({ event: "progress", data: { stage: "fetch", current: 2, total: 2, label: "y" } });
    handle.emit({ event: "done", data: { status: "completed" } });

    expect(received.map((r) => r.event)).toEqual(["progress", "progress", "done"]);
    expect(received.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(handle.isTerminal).toBe(true);
  });

  it("unsubscribe stops further delivery", () => {
    const handle = create("search", "run-1");
    const received: string[] = [];
    const unsubscribe = handle.subscribe((event) => received.push(event.event));
    handle.emit({ event: "progress", data: {} });
    unsubscribe();
    handle.emit({ event: "done", data: {} });
    expect(received).toEqual(["progress"]);
  });

  it("abort() aborts the handle's signal", () => {
    const handle = create("search", "run-1");
    expect(handle.signal.aborted).toBe(false);
    handle.abort("hard runtime cap exceeded");
    expect(handle.signal.aborted).toBe(true);
  });

  it("markStaleRunningOnBoot flips a leftover 'running' row to 'failed' and leaves others untouched", async () => {
    const repo = createSearchRunsRepo(state.testDb);
    const resume = await insertResume(state.testDb);
    const base = { userId: BOOTSTRAP_ADMIN_ID, resumeId: resume.id, personas: ["remote" as const], stats: { scanned: 0, matched: 0, scored: 0, worth: 0, ghosts: 0, perSource: [] } };

    const running = await repo.insert({ ...base, status: "running" });
    const completed = await repo.insert({ ...base, status: "completed" });

    await markStaleRunningOnBoot();

    expect((await repo.getById(running.id))?.status).toBe("failed");
    expect((await repo.getById(running.id))?.error).toMatch(/stale/i);
    expect((await repo.getById(completed.id))?.status).toBe("completed");
  });
});
