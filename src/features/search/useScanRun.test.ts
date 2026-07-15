// @vitest-environment jsdom
import { cleanup, renderHook, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job, SearchRun, SseEvent } from "@/types";
import { ApiError } from "@/features/http";

let capturedOnEvent: ((event: SseEvent) => void) | null = null;
const unsubscribe = vi.fn();
const startSearch = vi.fn();
const subscribeSearch = vi.fn((_id: string, onEvent: (event: SseEvent) => void) => {
  capturedOnEvent = onEvent;
  return unsubscribe;
});

vi.mock("./client", () => ({
  startSearch: (...args: unknown[]) => startSearch(...args),
  subscribeSearch: (...args: [string, (event: SseEvent) => void]) => subscribeSearch(...args),
}));

import { useScanRun } from "./useScanRun";

afterEach(() => {
  cleanup();
  capturedOnEvent = null;
  unsubscribe.mockClear();
  startSearch.mockClear();
  subscribeSearch.mockClear();
});

function searchRun(overrides: Partial<SearchRun> = {}): SearchRun {
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

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    score: 4,
    role: "Engineer",
    company: "Acme",
    meta: "Remote",
    verdict: "Good fit",
    why: "Matches skills",
    tags: [],
    breakdown: [],
    fit: [],
    gaps: [],
    legitimacy: { tier: "clear", tone: "good", summary: "Looks fine" },
    eligibility: { tier: "unknown", tone: "warn", summary: "test fixture" },
    applyUrl: "https://example.com/apply",
    source: { id: "src-1", name: "Acme Board", kind: "board", persona: "remote" },
    persona: "remote",
    firstSeen: "2026-07-11T00:00:00.000Z",
    isNew: true,
    ...overrides,
  };
}

describe("useScanRun", () => {
  it("start() on success subscribes and moves to running with the returned runId", async () => {
    startSearch.mockResolvedValue(searchRun({ id: "run-42" }));
    const { result } = renderHook(() => useScanRun());

    await act(async () => {
      await result.current.start("remote");
    });

    expect(startSearch).toHaveBeenCalledWith({ persona: "remote" });
    expect(subscribeSearch).toHaveBeenCalledWith("run-42", expect.any(Function));
    expect(result.current.state.runId).toBe("run-42");
    expect(result.current.state.status).toBe("running");
  });

  it("a progress event with stage:score advances the stage model", async () => {
    startSearch.mockResolvedValue(searchRun({ id: "run-42" }));
    const { result } = renderHook(() => useScanRun());

    await act(async () => {
      await result.current.start("remote");
    });

    act(() => {
      capturedOnEvent!({ event: "progress", data: { stage: "score", current: 4, total: 30, label: "4/30 scored" } });
    });

    const stages = result.current.state.stages;
    expect(stages.find((s) => s.stage === "score")!.state).toBe("active");
    expect(stages.find((s) => s.stage === "sources")!.state).toBe("done");
    expect(stages.find((s) => s.stage === "fetch")!.state).toBe("done");
  });

  it("a job event invokes options.onJob with the job", async () => {
    startSearch.mockResolvedValue(searchRun({ id: "run-42" }));
    const onJob = vi.fn();
    const { result } = renderHook(() => useScanRun({ onJob }));

    await act(async () => {
      await result.current.start("remote");
    });

    const theJob = job();
    act(() => {
      capturedOnEvent!({ event: "job", data: theJob });
    });

    expect(onJob).toHaveBeenCalledWith(theJob);
  });

  it("a done event (SearchRun) sets status done, populates stats, and invokes onDone", async () => {
    startSearch.mockResolvedValue(searchRun({ id: "run-42" }));
    const onDone = vi.fn();
    const { result } = renderHook(() => useScanRun({ onDone }));

    await act(async () => {
      await result.current.start("remote");
    });

    const finished = searchRun({ id: "run-42", status: "completed", stats: { scanned: 10, matched: 10, scored: 10, worth: 3, ghosts: 1, unscored: 0, capStopped: false, discoverMs: 0, scoreMs: 0, costUsd: 0, policyVersion: "test" } });
    act(() => {
      capturedOnEvent!({ event: "done", data: finished });
    });

    expect(result.current.state.status).toBe("done");
    expect(result.current.state.stats).toMatchObject({ scanned: 10, worth: 3, ghosts: 1 });
    expect(result.current.state.stages.every((s) => s.state === "done")).toBe(true);
    expect(onDone).toHaveBeenCalledWith(finished);
  });

  it("an error event sets status error with the envelope message", async () => {
    startSearch.mockResolvedValue(searchRun({ id: "run-42" }));
    const { result } = renderHook(() => useScanRun());

    await act(async () => {
      await result.current.start("remote");
    });

    act(() => {
      capturedOnEvent!({
        event: "error",
        data: { error: { code: "INTERNAL", message: "Something broke" } },
      });
    });

    expect(result.current.state.status).toBe("error");
    expect(result.current.state.error).toBe("Something broke");
  });

  it("start() receiving a 409 ApiError with details.activeRunId resubscribes to that run", async () => {
    startSearch.mockRejectedValue(new ApiError(409, "CONFLICT", "Already running", { activeRunId: "run-active" }));
    const { result } = renderHook(() => useScanRun());

    await act(async () => {
      await result.current.start("remote");
    });

    expect(subscribeSearch).toHaveBeenCalledWith("run-active", expect.any(Function));
    expect(result.current.state.runId).toBe("run-active");
    expect(result.current.state.status).toBe("running");
  });

  it("unmount calls the unsubscribe fn", async () => {
    startSearch.mockResolvedValue(searchRun({ id: "run-42" }));
    const { result, unmount } = renderHook(() => useScanRun());

    await act(async () => {
      await result.current.start("remote");
    });

    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
