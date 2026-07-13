// @vitest-environment jsdom
import { cleanup, renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, UrlCheck } from "@/types";

const startCheck = vi.fn();
const getCheck = vi.fn();
const getJob = vi.fn();

vi.mock("./client", () => ({
  startCheck: (...args: unknown[]) => startCheck(...args),
  getCheck: (...args: unknown[]) => getCheck(...args),
}));

vi.mock("@/features/feed/client", () => ({
  getJob: (...args: unknown[]) => getJob(...args),
}));

import { useUrlCheck } from "./useUrlCheck";

function check(overrides: Partial<UrlCheck> = {}): UrlCheck {
  return {
    id: "check-1",
    url: "https://example.com/job",
    status: "queued",
    stage: null,
    jobId: null,
    alreadyKnown: false,
    needsText: false,
    error: null,
    createdAt: "2026-07-12T00:00:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

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

// Steps fake timers in POLL_MS-sized chunks until getCheck has been called
// `n` times — avoids hand-computing the retry-cycle's variable timer spacing.
async function advanceUntilCalls(n: number) {
  while (getCheck.mock.calls.length < n) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  startCheck.mockReset();
  getCheck.mockReset();
  getJob.mockReset();
});

describe("useUrlCheck", () => {
  it("starts idle", () => {
    const { result } = renderHook(() => useUrlCheck());
    expect(result.current.state).toEqual({ status: "idle", stage: null, check: null, job: null });
  });

  it("submit() calls startCheck and moves to running with the returned stage", async () => {
    startCheck.mockResolvedValue(check({ status: "running", stage: "fetching" }));
    const { result } = renderHook(() => useUrlCheck());

    await act(async () => {
      await result.current.submit("https://example.com/job");
    });

    expect(startCheck).toHaveBeenCalledWith({ url: "https://example.com/job", text: undefined });
    expect(result.current.state.status).toBe("running");
    expect(result.current.state.stage).toBe("fetching");
  });

  it("polls getCheck every 1500ms while queued/running and advances the stage", async () => {
    startCheck.mockResolvedValue(check({ status: "running", stage: "fetching" }));
    getCheck.mockResolvedValueOnce(check({ status: "running", stage: "scoring" }));
    const { result } = renderHook(() => useUrlCheck());

    await act(async () => {
      await result.current.submit("https://example.com/job");
    });
    expect(getCheck).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(getCheck).toHaveBeenCalledWith("check-1");
    expect(result.current.state.stage).toBe("scoring");
  });

  it("a completed check fetches the job via the feed client and sets status done", async () => {
    startCheck.mockResolvedValue(check({ status: "running", stage: "scoring" }));
    getCheck.mockResolvedValueOnce(check({ status: "completed", stage: "scoring", jobId: "job-1" }));
    getJob.mockResolvedValue(job({ id: "job-1" }));
    const { result } = renderHook(() => useUrlCheck());

    await act(async () => {
      await result.current.submit("https://example.com/job");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(getJob).toHaveBeenCalledWith("job-1");
    expect(result.current.state.status).toBe("done");
    expect(result.current.state.job).toEqual(job({ id: "job-1" }));
  });

  it("an alreadyKnown completed response from startCheck resolves immediately without polling", async () => {
    startCheck.mockResolvedValue(check({ status: "completed", jobId: "job-9", alreadyKnown: true }));
    getJob.mockResolvedValue(job({ id: "job-9" }));
    const { result } = renderHook(() => useUrlCheck());

    await act(async () => {
      await result.current.submit("https://example.com/job");
    });

    expect(getCheck).not.toHaveBeenCalled();
    expect(result.current.state.status).toBe("done");
    expect(result.current.state.check?.alreadyKnown).toBe(true);
  });

  it("a failed check with needsText:true sets status needsText", async () => {
    startCheck.mockResolvedValue(check({ status: "running", stage: "searching" }));
    getCheck.mockResolvedValueOnce(
      check({ status: "failed", needsText: true, error: { code: "FETCH_BLOCKED", message: "Blocked by the site." } }),
    );
    const { result } = renderHook(() => useUrlCheck());

    await act(async () => {
      await result.current.submit("https://example.com/job");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(result.current.state.status).toBe("needsText");
    expect(getJob).not.toHaveBeenCalled();
  });

  it("a failed check with needsText:false sets status failed", async () => {
    startCheck.mockResolvedValue(check({ status: "running", stage: "extracting" }));
    getCheck.mockResolvedValueOnce(
      check({ status: "failed", needsText: false, error: { code: "NOT_A_JOB_POSTING", message: "Not a job posting." } }),
    );
    const { result } = renderHook(() => useUrlCheck());

    await act(async () => {
      await result.current.submit("https://example.com/job");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(result.current.state.status).toBe("failed");
  });

  it("dismiss() resets to idle and stops further polling", async () => {
    startCheck.mockResolvedValue(check({ status: "running", stage: "fetching" }));
    const { result } = renderHook(() => useUrlCheck());

    await act(async () => {
      await result.current.submit("https://example.com/job");
    });

    act(() => {
      result.current.dismiss();
    });
    expect(result.current.state).toEqual({ status: "idle", stage: null, check: null, job: null });

    getCheck.mockResolvedValueOnce(check({ status: "running", stage: "scoring" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(getCheck).not.toHaveBeenCalled();
  });

  it("a startCheck rejection (e.g. 409/422 admission error) sets status failed with no check", async () => {
    startCheck.mockRejectedValue(new Error("No active résumé."));
    const { result } = renderHook(() => useUrlCheck());

    await act(async () => {
      await result.current.submit("https://example.com/job");
    });

    expect(result.current.state).toEqual({ status: "failed", stage: null, check: null, job: null });
  });

  // final-review fix wave FIX 1b: every async resume must be caught and
  // routed to a generation-guarded retry-or-fail instead of hanging in
  // "running" — but (per the poll fault-tolerance fix above) a persistent
  // failure, not a single blip, is what's required to actually surface as
  // "failed".

  it("a persistent getJob rejection after a completed check eventually sets status failed instead of hanging forever", async () => {
    startCheck.mockResolvedValue(check({ status: "running", stage: "scoring" }));
    getCheck.mockResolvedValueOnce(check({ status: "completed", stage: "scoring", jobId: "job-1" }));
    getJob.mockRejectedValue(new Error("job fetch failed"));
    const { result } = renderHook(() => useUrlCheck());

    await act(async () => {
      await result.current.submit("https://example.com/job");
    });
    while (getJob.mock.calls.length < 8) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
    }

    expect(result.current.state.status).toBe("failed");
    expect(result.current.state.job).toBeNull();
  });

  it("a single getCheck poll rejection mid-run retries instead of failing immediately", async () => {
    startCheck.mockResolvedValue(check({ status: "running", stage: "fetching" }));
    getCheck.mockRejectedValueOnce(new Error("network blip"));
    const { result } = renderHook(() => useUrlCheck());

    await act(async () => {
      await result.current.submit("https://example.com/job");
    });
    await advanceUntilCalls(1);

    expect(result.current.state.status).toBe("running");
  });

  it("a stale poll rejection from a superseded generation does not clobber the fresh run's state", async () => {
    const stalePoll = deferred<UrlCheck>();
    startCheck.mockResolvedValueOnce(check({ id: "check-1", status: "running", stage: "fetching" }));
    getCheck.mockImplementationOnce(() => stalePoll.promise);
    const { result } = renderHook(() => useUrlCheck());

    await act(async () => {
      await result.current.submit("https://example.com/job");
    });
    // Fires the poll timer, which invokes getCheck() — still pending.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    // A second submit supersedes generation #1 before the first poll settles.
    startCheck.mockResolvedValueOnce(check({ id: "check-2", status: "running", stage: "searching" }));
    await act(async () => {
      await result.current.submit("https://example.com/job2");
    });
    expect(result.current.state.check?.id).toBe("check-2");
    expect(result.current.state.stage).toBe("searching");

    // The stale generation's poll now rejects — it must be a silent no-op.
    await act(async () => {
      stalePoll.reject(new Error("stale network failure"));
      await Promise.resolve().then(() => Promise.resolve());
    });

    expect(result.current.state.status).toBe("running");
    expect(result.current.state.check?.id).toBe("check-2");
    expect(result.current.state.stage).toBe("searching");
  });

  // final-review fix wave FIX 4: the generationRef machinery had zero direct
  // coverage — these pin the guard against a stale SUCCESSFUL resolution
  // (distinct from the stale-rejection test above), using manually-resolved
  // promises to sequence the race deterministically.

  it("a stale poll success from a superseded generation does not clobber a fresh submit's state", async () => {
    const stalePoll = deferred<UrlCheck>();
    startCheck.mockResolvedValueOnce(check({ id: "check-1", status: "running", stage: "fetching" }));
    getCheck.mockImplementationOnce(() => stalePoll.promise);
    const { result } = renderHook(() => useUrlCheck());

    await act(async () => {
      await result.current.submit("https://example.com/job");
    });
    // Fires the poll timer, which invokes getCheck() — still pending.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    // A second submit supersedes generation #1 before the first poll settles.
    startCheck.mockResolvedValueOnce(check({ id: "check-2", status: "running", stage: "searching" }));
    await act(async () => {
      await result.current.submit("https://example.com/job2");
    });

    // The stale generation's poll now resolves successfully — it must be a
    // silent no-op, not a jump back to whatever it reports.
    await act(async () => {
      stalePoll.resolve(check({ id: "check-1", status: "completed", jobId: "job-1" }));
      await Promise.resolve().then(() => Promise.resolve());
    });

    expect(result.current.state.check?.id).toBe("check-2");
    expect(result.current.state.status).toBe("running");
    expect(result.current.state.stage).toBe("searching");
    expect(getJob).not.toHaveBeenCalled();
  });

  it("a stale getJob success arriving after dismiss() does not clobber the idle state", async () => {
    const staleGetJob = deferred<Job>();
    startCheck.mockResolvedValue(check({ id: "check-1", status: "running", stage: "scoring" }));
    getCheck.mockResolvedValueOnce(check({ id: "check-1", status: "completed", stage: "scoring", jobId: "job-1" }));
    getJob.mockImplementationOnce(() => staleGetJob.promise);
    const { result } = renderHook(() => useUrlCheck());

    await act(async () => {
      await result.current.submit("https://example.com/job");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    // getJob is now pending (deferred) — the "completed" branch is mid-flight.
    expect(result.current.state.status).toBe("running");

    act(() => {
      result.current.dismiss();
    });
    expect(result.current.state).toEqual({ status: "idle", stage: null, check: null, job: null });

    await act(async () => {
      staleGetJob.resolve(job({ id: "job-1" }));
      await Promise.resolve().then(() => Promise.resolve());
    });

    expect(result.current.state).toEqual({ status: "idle", stage: null, check: null, job: null });
  });

  // Poll fault-tolerance: a single transient getCheck rejection (dev-recompile
  // 500, network blip) must not permanently fail a run — only MAX_POLL_FAILURES
  // *consecutive* rejections, or the overall run deadline, do.

  it("a transient getCheck rejection followed by a success stays running, then completes", async () => {
    startCheck.mockResolvedValue(check({ status: "running", stage: "fetching" }));
    getCheck
      .mockRejectedValueOnce(new Error("dev-recompile 500"))
      .mockResolvedValueOnce(check({ status: "completed", stage: "scoring", jobId: "job-1" }));
    getJob.mockResolvedValue(job({ id: "job-1" }));
    const { result } = renderHook(() => useUrlCheck());

    await act(async () => {
      await result.current.submit("https://example.com/job");
    });

    await advanceUntilCalls(1);
    expect(result.current.state.status).toBe("running");

    await advanceUntilCalls(2);
    expect(result.current.state.status).toBe("done");
    expect(getJob).toHaveBeenCalledWith("job-1");
  });

  it("MAX_POLL_FAILURES consecutive getCheck rejections gives up and sets status failed", async () => {
    startCheck.mockResolvedValue(check({ status: "running", stage: "fetching" }));
    getCheck.mockRejectedValue(new Error("network blip"));
    const { result } = renderHook(() => useUrlCheck());

    await act(async () => {
      await result.current.submit("https://example.com/job");
    });

    await advanceUntilCalls(8);

    expect(getCheck).toHaveBeenCalledTimes(8);
    expect(result.current.state.status).toBe("failed");
  });

  it("a success mid-streak resets the poll-failure counter (5 fails, success, 5 fails stays running)", async () => {
    startCheck.mockResolvedValue(check({ status: "running", stage: "fetching" }));
    for (let i = 0; i < 5; i++) getCheck.mockRejectedValueOnce(new Error(`blip ${i}`));
    getCheck.mockResolvedValueOnce(check({ status: "running", stage: "searching" }));
    for (let i = 0; i < 5; i++) getCheck.mockRejectedValueOnce(new Error(`blip ${5 + i}`));
    const { result } = renderHook(() => useUrlCheck());

    await act(async () => {
      await result.current.submit("https://example.com/job");
    });

    await advanceUntilCalls(11);

    expect(result.current.state.status).toBe("running");
  });

  it("dismiss() during an in-flight poll's retry window is a silent no-op (generation guard)", async () => {
    const stalePoll = deferred<UrlCheck>();
    startCheck.mockResolvedValueOnce(check({ id: "check-1", status: "running", stage: "fetching" }));
    getCheck.mockImplementationOnce(() => stalePoll.promise);
    const { result } = renderHook(() => useUrlCheck());

    await act(async () => {
      await result.current.submit("https://example.com/job");
    });
    // Fires the poll timer, which invokes getCheck() — still pending.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    act(() => {
      result.current.dismiss();
    });
    expect(result.current.state).toEqual({ status: "idle", stage: null, check: null, job: null });

    // The in-flight poll now rejects for the dismissed generation —
    // retryOrFail's generation guard must make this a silent no-op, not a
    // jump to "failed" or a new retry timer.
    await act(async () => {
      stalePoll.reject(new Error("transient failure after dismiss"));
      await Promise.resolve().then(() => Promise.resolve());
    });

    expect(result.current.state).toEqual({ status: "idle", stage: null, check: null, job: null });
  });
});
