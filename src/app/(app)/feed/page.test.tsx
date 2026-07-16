// @vitest-environment jsdom
// D7: Feed "Scan now" no longer opens an in-feed live overlay — it starts a
// run via startSearch and navigates to the run's /scans/:id home, routing to
// the already-active run on a 409 CONFLICT instead of erroring.
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { ApiError } from "@/features/http";

afterEach(cleanup);

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

const { getJobs, deleteJob, startSearch } = vi.hoisted(() => ({
  getJobs: vi.fn(),
  deleteJob: vi.fn(),
  startSearch: vi.fn(),
}));
vi.mock("@/features/feed/client", () => ({ getJobs, deleteJob }));
vi.mock("@/features/search/client", () => ({ startSearch }));
const doneCountState = vi.hoisted(() => ({ value: 0 }));
vi.mock("@/features/url-check/checksStore", () => ({
  useUrlChecks: () => ({
    runs: [],
    active: [],
    doneCount: doneCountState.value,
    submit: vi.fn(),
    submitEvaluate: vi.fn(),
    retryWithText: vi.fn(),
    dismiss: vi.fn(),
    clearFinished: vi.fn(),
  }),
}));

import FeedPage from "./page";

const EMPTY_FEED = {
  items: [],
  stats: { scanned: 0, worth: 0, ghosts: 0, flagged: 0, sinceLast: 0, excluded: 0 },
};

beforeEach(() => {
  push.mockReset();
  getJobs.mockReset();
  getJobs.mockResolvedValue(EMPTY_FEED);
  startSearch.mockReset();
  doneCountState.value = 0;
});

describe("FeedPage 'Scan now'", () => {
  it("starts a run for the active persona and navigates to its /scans detail", async () => {
    startSearch.mockResolvedValue({ id: "r-new" });
    render(<FeedPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Scan now" }));

    await waitFor(() => expect(startSearch).toHaveBeenCalledWith({ persona: "remote" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/scans/r-new"));
  });

  it("routes to the already-active run on a 409 CONFLICT instead of erroring", async () => {
    startSearch.mockRejectedValue(
      new ApiError(409, "CONFLICT", "A scan is already running for this persona.", { activeRunId: "r-active" }),
    );
    render(<FeedPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Scan now" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/scans/r-active"));
  });
});

describe("FeedPage doneCount reload coalescing", () => {
  it("coalesces rapid doneCount bumps during an in-flight load into a single trailing fetch", async () => {
    let resolveFirst!: (v: typeof EMPTY_FEED) => void;
    const first = new Promise<typeof EMPTY_FEED>((resolve) => { resolveFirst = resolve; });
    getJobs.mockReturnValueOnce(first);

    const { rerender } = render(<FeedPage />);
    await waitFor(() => expect(getJobs).toHaveBeenCalledTimes(1));

    // Three rapid doneCount bumps while the mount's load() is still in flight.
    doneCountState.value = 1;
    rerender(<FeedPage />);
    doneCountState.value = 2;
    rerender(<FeedPage />);
    doneCountState.value = 3;
    rerender(<FeedPage />);

    expect(getJobs).toHaveBeenCalledTimes(1); // bumps queued, not fired

    resolveFirst(EMPTY_FEED);
    await waitFor(() => expect(getJobs).toHaveBeenCalledTimes(2)); // one trailing reload

    await new Promise((r) => setTimeout(r, 0));
    expect(getJobs).toHaveBeenCalledTimes(2); // no further calls leak out
  });
});
