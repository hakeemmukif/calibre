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
});
