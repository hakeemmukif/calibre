// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanDetail, SearchRun, SearchRunSummary, SseEvent } from "@/types";

const requestJsonMock = vi.fn();
vi.mock("@/features/http", () => ({
  requestJson: (...args: unknown[]) => requestJsonMock(...args),
}));

import { getScanDetail, listScans, subscribeSearch } from "./client";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, Set<(e: MessageEvent<string>) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, handler: (e: MessageEvent<string>) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(handler);
  }

  removeEventListener(name: string, handler: (e: MessageEvent<string>) => void) {
    this.listeners.get(name)?.delete(handler);
  }

  close() {
    this.closed = true;
  }

  emit(name: string, data: unknown) {
    for (const handler of this.listeners.get(name) ?? []) {
      handler({ data: JSON.stringify(data) } as MessageEvent<string>);
    }
  }
}

function snapshot(overrides: Partial<SearchRun> = {}): SearchRun {
  return {
    id: "run-1",
    status: "running",
    persona: "remote",
    sources: [],
    progress: null,
    stats: { scanned: 0, matched: 0, scored: 0, worth: 0, ghosts: 0, unscored: 0, capStopped: false, discoverMs: 0, scoreMs: 0, costUsd: 0, policyVersion: "test" },
    startedAt: "2026-07-11T00:00:00.000Z",
    finishedAt: null,
    error: null,
    ...overrides,
  };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  requestJsonMock.mockReset();
});

describe("subscribeSearch", () => {
  it("forwards a done event to onEvent and closes the source", () => {
    const onEvent = vi.fn();
    subscribeSearch("run-1", onEvent);
    const source = FakeEventSource.instances[0]!;

    const finished = snapshot({ status: "completed" });
    source.emit("done", finished);

    expect(onEvent).toHaveBeenCalledWith({ event: "done", data: finished } satisfies SseEvent);
    expect(source.closed).toBe(true);
  });

  it("forwards an error event to onEvent and closes the source", () => {
    const onEvent = vi.fn();
    subscribeSearch("run-1", onEvent);
    const source = FakeEventSource.instances[0]!;

    const envelope = { error: { code: "INTERNAL" as const, message: "boom" } };
    source.emit("error", envelope);

    expect(onEvent).toHaveBeenCalledWith({ event: "error", data: envelope } satisfies SseEvent);
    expect(source.closed).toBe(true);
  });

  it("a transport onerror does not close the source or emit an event (native auto-reconnect)", () => {
    const onEvent = vi.fn();
    subscribeSearch("run-1", onEvent);
    const source = FakeEventSource.instances[0]!;

    source.onerror?.();

    expect(source.closed).toBe(false);
    expect(onEvent).not.toHaveBeenCalled();
    expect(requestJsonMock).not.toHaveBeenCalled();
  });

  it("cleanup removes listeners and closes the source", () => {
    const onEvent = vi.fn();
    const cleanup = subscribeSearch("run-1", onEvent);
    const source = FakeEventSource.instances[0]!;

    cleanup();
    expect(source.closed).toBe(true);

    source.emit("progress", { stage: "score", current: 1, total: 10, label: "1/10" });
    expect(onEvent).not.toHaveBeenCalled();
  });
});

function scanSummary(overrides: Partial<SearchRunSummary> = {}): SearchRunSummary {
  return {
    id: "run-1",
    status: "completed",
    persona: "remote",
    resumeName: "jane_v2.pdf",
    startedAt: "2026-07-11T00:00:00.000Z",
    finishedAt: "2026-07-11T00:05:00.000Z",
    stats: {
      scanned: 40, matched: 30, scored: 28, worth: 6, ghosts: 2, unscored: 1,
      capStopped: false, discoverMs: 4200, scoreMs: 58000, costUsd: 0.42, policyVersion: "p3",
    },
    ...overrides,
  };
}

describe("listScans", () => {
  it("GETs /api/search with no query params and returns the parsed items + nextCursor", async () => {
    const summary = scanSummary();
    requestJsonMock.mockImplementation((_url: string, _init: unknown, schema: { parse: (v: unknown) => unknown }) =>
      Promise.resolve(schema.parse({ items: [summary], nextCursor: null })),
    );

    const result = await listScans();

    expect(requestJsonMock).toHaveBeenCalledWith("/api/search", undefined, expect.anything());
    expect(result).toEqual({ items: [summary], nextCursor: null });
  });

  it("builds the query string from limit/cursor and rejects a malformed item", async () => {
    requestJsonMock.mockImplementation((_url: string, _init: unknown, schema: { parse: (v: unknown) => unknown }) =>
      Promise.resolve(schema.parse({ items: [{ id: "run-1" }], nextCursor: "c2" })),
    );

    await expect(listScans({ limit: 10, cursor: "c1" })).rejects.toThrow();
    expect(requestJsonMock).toHaveBeenCalledWith("/api/search?limit=10&cursor=c1", undefined, expect.anything());
  });
});

describe("getScanDetail", () => {
  it("GETs /api/search/:id and returns the parsed ScanDetail", async () => {
    const detail: ScanDetail = { ...scanSummary(), error: null, results: [] };
    requestJsonMock.mockImplementation((_url: string, _init: unknown, schema: { parse: (v: unknown) => unknown }) =>
      Promise.resolve(schema.parse(detail)),
    );

    const result = await getScanDetail("run-1");

    expect(requestJsonMock).toHaveBeenCalledWith("/api/search/run-1", undefined, expect.anything());
    expect(result).toEqual(detail);
  });

  it("throws when the response is missing results[] (SearchRunSummary shape, not ScanDetail)", async () => {
    requestJsonMock.mockImplementation((_url: string, _init: unknown, schema: { parse: (v: unknown) => unknown }) =>
      Promise.resolve(schema.parse(scanSummary())),
    );

    await expect(getScanDetail("run-1")).rejects.toThrow();
  });
});
