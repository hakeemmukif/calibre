// @vitest-environment jsdom
// M1 whole-branch-review fix: the page fetched getScanDetail once at mount
// and rendered the running bridge (useScanRun + ScanProgress) while
// detail.status === "running", but useScanRun() was wired with no
// onDone/onError — so when the SSE done/error event arrived the page never
// refetched and stayed stuck on "running" forever. Asserts the fixed
// transition: a run mounted as "running", once useScanRun's onDone fires,
// refetches getScanDetail and renders the terminal ScanReplay.
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import type { ScanDetail, SearchRun, SseEvent } from "@/types";

afterEach(cleanup);

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "run-1" }),
}));

let capturedOnEvent: ((event: SseEvent) => void) | null = null;
const { getScanDetail, subscribeSearch, startSearch } = vi.hoisted(() => ({
  getScanDetail: vi.fn(),
  subscribeSearch: vi.fn(),
  startSearch: vi.fn(),
}));
vi.mock("@/features/search/client", () => ({ getScanDetail, subscribeSearch, startSearch }));

import ScanDetailPage from "./page";

function runningDetail(): ScanDetail {
  return {
    id: "run-1",
    status: "running",
    persona: "remote",
    resumeName: "jane_v2.pdf",
    startedAt: "2026-07-15T10:00:00.000Z",
    finishedAt: null,
    error: null,
    stats: { scanned: 0, matched: 0, scored: 0, worth: 0, ghosts: 0, unscored: 0, capStopped: false, discoverMs: 0, scoreMs: 0, costUsd: 0, policyVersion: "p3" },
    results: [],
  };
}

function terminalDetail(): ScanDetail {
  return {
    id: "run-1",
    status: "completed",
    persona: "remote",
    resumeName: "jane_v2.pdf",
    startedAt: "2026-07-15T10:00:00.000Z",
    finishedAt: "2026-07-15T10:01:02.000Z",
    error: null,
    stats: { scanned: 10, matched: 8, scored: 8, worth: 3, ghosts: 1, unscored: 0, capStopped: false, discoverMs: 4200, scoreMs: 58000, costUsd: 0.42, policyVersion: "p3" },
    results: [],
  };
}

function finishedSearchRun(): SearchRun {
  return {
    id: "run-1",
    status: "completed",
    persona: "remote",
    sources: [],
    progress: null,
    stats: { scanned: 10, matched: 8, scored: 8, worth: 3, ghosts: 1, unscored: 0, capStopped: false, discoverMs: 4200, scoreMs: 58000, costUsd: 0.42, policyVersion: "p3" },
    startedAt: "2026-07-15T10:00:00.000Z",
    finishedAt: "2026-07-15T10:01:02.000Z",
    error: null,
  };
}

beforeEach(() => {
  capturedOnEvent = null;
  getScanDetail.mockReset();
  subscribeSearch.mockReset();
  startSearch.mockReset();
  subscribeSearch.mockImplementation((_id: string, onEvent: (event: SseEvent) => void) => {
    capturedOnEvent = onEvent;
    return vi.fn();
  });
});

describe("/scans/:id — running-to-terminal transition", () => {
  it("refetches and renders ScanReplay once useScanRun's onDone fires", async () => {
    getScanDetail.mockResolvedValueOnce(runningDetail());
    render(<ScanDetailPage />);

    await waitFor(() => expect(subscribeSearch).toHaveBeenCalledWith("run-1", expect.any(Function)));
    expect(screen.getByText("Discovering postings")).toBeInTheDocument();

    getScanDetail.mockResolvedValueOnce(terminalDetail());
    act(() => {
      capturedOnEvent!({ event: "done", data: finishedSearchRun() });
    });

    await waitFor(() => expect(getScanDetail).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Discover")).toBeInTheDocument();
    expect(screen.queryByText("Discovering postings")).not.toBeInTheDocument();
  });
});
