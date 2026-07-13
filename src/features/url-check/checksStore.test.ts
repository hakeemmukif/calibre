// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, UrlCheck, UrlChecksSnapshot } from "@/types";

const startCheck = vi.fn();
const getChecksByIds = vi.fn();
const getActiveChecks = vi.fn();
const getJob = vi.fn();
const evaluateJob = vi.fn();

vi.mock("./client", () => ({
  startCheck: (...a: unknown[]) => startCheck(...a),
  getChecksByIds: (...a: unknown[]) => getChecksByIds(...a),
  getActiveChecks: (...a: unknown[]) => getActiveChecks(...a),
}));
vi.mock("@/features/feed/client", () => ({
  getJob: (...a: unknown[]) => getJob(...a),
  evaluateJob: (...a: unknown[]) => evaluateJob(...a),
}));

import { useUrlChecks, __resetChecksStore } from "./checksStore";

function check(o: Partial<UrlCheck> = {}): UrlCheck {
  return { id: "check-1", url: "https://example.com/job", status: "queued", stage: null, jobId: null,
    alreadyKnown: false, needsText: false, error: null, createdAt: "2026-07-13T00:00:00.000Z", finishedAt: null, ...o };
}
function snap(checks: UrlCheck[], paused = false): UrlChecksSnapshot { return { checks, paused }; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
    source: { id: "manual", name: "Manual URL", kind: "manual", persona: "pasted" },
    persona: "pasted",
    firstSeen: "2026-07-12T00:00:00.000Z",
    isNew: false,
    ...overrides,
  };
}

beforeEach(() => { vi.useFakeTimers(); __resetChecksStore(); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("checksStore", () => {
  it("two submits COLLECT (both survive) rather than supersede", async () => {
    startCheck.mockResolvedValueOnce(check({ id: "c1", status: "running", stage: "fetching" }))
              .mockResolvedValueOnce(check({ id: "c2", status: "running", stage: "fetching" }));
    const { result } = renderHook(() => useUrlChecks());
    await act(async () => { result.current.submit("https://a.com/1"); });
    await act(async () => { result.current.submit("https://b.com/2"); });
    expect(result.current.runs).toHaveLength(2);
    expect(result.current.active).toHaveLength(2);
  });

  it("submit dedupes an already-active URL (returns the existing key)", async () => {
    startCheck.mockResolvedValue(check({ id: "c1", status: "running", stage: "fetching" }));
    const { result } = renderHook(() => useUrlChecks());
    let k1 = "", k2 = "";
    await act(async () => { k1 = result.current.submit("https://a.com/1"); });
    await act(async () => { k2 = result.current.submit("https://a.com/1"); });
    expect(k1).toBe(k2);
    expect(result.current.runs).toHaveLength(1);
  });

  it("a completed poll fetches the Job, moves the run to done, bumps doneCount", async () => {
    startCheck.mockResolvedValue(check({ id: "c1", status: "running", stage: "scoring" }));
    getChecksByIds.mockResolvedValue(snap([check({ id: "c1", status: "completed", stage: "scoring", jobId: "job-1" })]));
    getJob.mockResolvedValue(job({ id: "job-1" }));
    const { result } = renderHook(() => useUrlChecks());
    await act(async () => { result.current.submit("https://a.com/1"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(result.current.runs[0].phase).toBe("done");
    expect(result.current.runs[0].job?.id).toBe("job-1");
    expect(result.current.doneCount).toBe(1);
  });

  it("dismiss(key) then a late poll for that key is a silent no-op", async () => {
    startCheck.mockResolvedValue(check({ id: "c1", status: "running", stage: "fetching" }));
    const { result } = renderHook(() => useUrlChecks());
    let key = "";
    await act(async () => { key = result.current.submit("https://a.com/1"); });
    act(() => { result.current.dismiss(key); });
    getChecksByIds.mockResolvedValue(snap([check({ id: "c1", status: "completed", jobId: "job-1" })]));
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(result.current.runs).toHaveLength(0); // dismissed run never resurrects
  });

  it("MAX_POLL_FAILURES consecutive batch failures fail only that run", async () => {
    startCheck.mockResolvedValue(check({ id: "c1", status: "running", stage: "fetching" }));
    getChecksByIds.mockRejectedValue(new Error("network blip"));
    const { result } = renderHook(() => useUrlChecks());
    await act(async () => { result.current.submit("https://a.com/1"); });
    for (let i = 0; i < 8; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(result.current.runs[0].phase).toBe("failed");
  });

  it("submitEvaluate wraps the synchronous evaluate as a done run with the fresh job", async () => {
    evaluateJob.mockResolvedValue(job({ id: "job-9" }));
    const { result } = renderHook(() => useUrlChecks());
    await act(async () => { result.current.submitEvaluate("job-9"); });
    expect(result.current.runs[0].origin).toBe("reevaluate");
    expect(result.current.runs[0].phase).toBe("done");
    expect(result.current.runs[0].job?.id).toBe("job-9");
  });

  it("overlapping ticks don't double-process a slow batch poll (pollInFlight guard)", async () => {
    const jobDeferred = deferred<Job>();
    startCheck.mockResolvedValue(check({ id: "c1", status: "running", stage: "fetching" }));
    getChecksByIds.mockResolvedValue(snap([check({ id: "c1", status: "completed", stage: "scoring", jobId: "job-1" })]));
    getJob.mockImplementation(() => jobDeferred.promise);
    const { result } = renderHook(() => useUrlChecks());
    await act(async () => { result.current.submit("https://a.com/1"); });
    // tick1: getChecksByIds resolves, applySnapshot enters the "done" branch and calls getJob — pending.
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    // tick2: must no-op via pollInFlight (tick1 hasn't finished awaiting getJob yet).
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    await act(async () => {
      jobDeferred.resolve(job({ id: "job-1" }));
      await Promise.resolve().then(() => Promise.resolve());
    });
    expect(getJob).toHaveBeenCalledTimes(1);
    expect(result.current.doneCount).toBe(1);
  });

  it("persistent getJob failure eventually fails the run instead of spinning forever", async () => {
    startCheck.mockResolvedValue(check({ id: "c1", status: "running", stage: "fetching" }));
    getChecksByIds.mockResolvedValue(snap([check({ id: "c1", status: "completed", stage: "scoring", jobId: "job-1" })]));
    getJob.mockRejectedValue(new Error("job fetch failed"));
    const { result } = renderHook(() => useUrlChecks());
    await act(async () => { result.current.submit("https://a.com/1"); });
    for (let i = 0; i < 8; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(result.current.runs[0].phase).toBe("failed");
  });

  it("scored-dedupe short-circuit lands phase+job+doneCount together, not phase alone in an earlier emit", async () => {
    const jobDeferred = deferred<Job>();
    startCheck.mockResolvedValueOnce(check({ id: "c1", status: "completed", jobId: "job-1", alreadyKnown: true }));
    getJob.mockImplementationOnce(() => jobDeferred.promise);
    const { result } = renderHook(() => useUrlChecks());
    await act(async () => { result.current.submit("https://a.com/1"); });
    // startCheck's .then has resolved and getJob has been called, but it's still pending —
    // phase must NOT already read "done" (that would desync it from doneCount/job, landing
    // in an earlier emit than the run finishing).
    expect(result.current.runs[0].phase).not.toBe("done");
    expect(result.current.doneCount).toBe(0);
    await act(async () => {
      jobDeferred.resolve(job({ id: "job-1" }));
      await Promise.resolve().then(() => Promise.resolve());
    });
    expect(result.current.runs[0].phase).toBe("done");
    expect(result.current.runs[0].job?.id).toBe("job-1");
    expect(result.current.runs[0].alreadyKnown).toBe(true);
    expect(result.current.doneCount).toBe(1);
  });

  it("scored-dedupe short-circuit retries via the timer backstop when the immediate getJob fails", async () => {
    startCheck.mockResolvedValueOnce(check({ id: "c1", status: "completed", jobId: "job-1", alreadyKnown: true }));
    getChecksByIds.mockResolvedValue(snap([check({ id: "c1", status: "completed", jobId: "job-1", alreadyKnown: true })]));
    getJob.mockRejectedValueOnce(new Error("blip")).mockResolvedValueOnce(job({ id: "job-1" }));
    const { result } = renderHook(() => useUrlChecks());
    await act(async () => {
      result.current.submit("https://a.com/1");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.runs[0].phase).not.toBe("done"); // immediate attempt failed, not stranded
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); }); // retry backstop tick
    expect(result.current.runs[0].phase).toBe("done");
    expect(result.current.runs[0].job?.id).toBe("job-1");
  });

  it("dismiss during an in-flight poll does not resurrect the run", async () => {
    const jobDeferred = deferred<Job>();
    startCheck.mockResolvedValue(check({ id: "c1", status: "running", stage: "fetching" }));
    getChecksByIds.mockResolvedValue(snap([check({ id: "c1", status: "completed", stage: "scoring", jobId: "job-1" })]));
    getJob.mockImplementation(() => jobDeferred.promise);
    const { result } = renderHook(() => useUrlChecks());
    let key = "";
    await act(async () => { key = result.current.submit("https://a.com/1"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); }); // tick fires, getJob pending
    act(() => { result.current.dismiss(key); });
    await act(async () => {
      jobDeferred.resolve(job({ id: "job-1" }));
      await Promise.resolve().then(() => Promise.resolve());
    });
    expect(result.current.runs).toHaveLength(0);
    expect(result.current.doneCount).toBe(0);
  });

  it("MAX_POLL_FAILURES isolates per-run: one run fails while a sibling completes", async () => {
    startCheck.mockResolvedValueOnce(check({ id: "cA", status: "running", stage: "fetching" }))
              .mockResolvedValueOnce(check({ id: "cB", status: "running", stage: "fetching" }));
    getChecksByIds.mockResolvedValue(snap([
      check({ id: "cA", status: "completed", jobId: "job-A" }),
      check({ id: "cB", status: "completed", jobId: "job-B" }),
    ]));
    getJob.mockImplementation((jobId: string) =>
      jobId === "job-A" ? Promise.reject(new Error("A always fails")) : Promise.resolve(job({ id: "job-B" })),
    );
    const { result } = renderHook(() => useUrlChecks());
    await act(async () => { result.current.submit("https://a.com/A"); });
    await act(async () => { result.current.submit("https://b.com/B"); });
    for (let i = 0; i < 8; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    const runA = result.current.runs.find((r) => r.url === "https://a.com/A");
    const runB = result.current.runs.find((r) => r.url === "https://b.com/B");
    expect(runA?.phase).toBe("failed");
    expect(runB?.phase).toBe("done");
    expect(result.current.doneCount).toBe(1);
  });
});
