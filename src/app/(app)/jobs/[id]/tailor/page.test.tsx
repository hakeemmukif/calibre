// @vitest-environment jsdom
// perf/scan-overhead: pollCorrelateUntilTerminal is a `while (true)` loop
// polling GET /api/tailor/correlate/:id every POLL_INTERVAL_MS — unmounting
// mid-run must stop it (see pollUntilTerminal's twin, same fix). Asserts the
// alive-flag cancellation actually halts further getCorrelate calls once the
// component leaves the tree.
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { jobs, resume, correlationReport } from "@/caliber-ui/fixtures";

afterEach(cleanup);

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: jobs[0].id }),
  useRouter: () => ({ push: vi.fn() }),
}));

const { getJob, getResume, getCorrelate, startCorrelate } = vi.hoisted(() => ({
  getJob: vi.fn(),
  getResume: vi.fn(),
  getCorrelate: vi.fn(),
  startCorrelate: vi.fn(),
}));
vi.mock("@/features/feed/client", () => ({ getJob }));
vi.mock("@/features/resume/client", () => ({ getResume }));
vi.mock("@/features/tailor/client", () => ({
  getCorrelate,
  startCorrelate,
  getTailor: vi.fn(),
  startTailor: vi.fn(),
  finalizeTailor: vi.fn(),
  tailorPdfUrl: (id: string) => `/api/tailor/${id}/pdf`,
}));

import TailorPage from "./page";

const pendingReport = { ...correlationReport, status: "running" as const };

beforeEach(() => {
  vi.useFakeTimers();
  getJob.mockReset().mockResolvedValue(jobs[0]);
  getResume.mockReset().mockResolvedValue(resume);
  startCorrelate.mockReset().mockResolvedValue(pendingReport);
  getCorrelate.mockReset().mockResolvedValue(pendingReport);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TailorPage — poll cancellation on unmount", () => {
  it("stops polling GET /api/tailor/correlate/:id once the component unmounts", async () => {
    const { unmount } = render(<TailorPage />);

    // Flush the mount effect's Promise.all([getJob, getResume]).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /analyze fit/i }));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(startCorrelate).toHaveBeenCalledWith({ jobId: jobs[0].id });
    const callsAtUnmount = getCorrelate.mock.calls.length;
    expect(callsAtUnmount).toBeGreaterThan(0);

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200 * 5);
    });
    expect(getCorrelate.mock.calls.length).toBe(callsAtUnmount);
  });
});
