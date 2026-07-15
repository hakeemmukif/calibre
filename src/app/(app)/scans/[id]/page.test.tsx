// @vitest-environment jsdom
// M2 T7: the running branch now renders the live concurrency-lane view
// (SourceStrip + ScanLanes fed by useScanLive) instead of the M1 coarse
// ScanProgress bridge. Asserts: (1) a running run renders lanes, not the
// coarse "Discovering postings" bar; (2) once useScanLive's SSE stream
// reaches "done", the page refetches getScanDetail and renders the terminal
// ScanReplay.
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

describe("/scans/:id — live lanes view", () => {
  it("renders SourceStrip + ScanLanes for a running run, not the coarse bar", async () => {
    getScanDetail.mockResolvedValueOnce(runningDetail());
    render(<ScanDetailPage />);

    await waitFor(() => expect(subscribeSearch).toHaveBeenCalledWith("run-1", expect.any(Function)));

    act(() => {
      capturedOnEvent!({ event: "source", data: { sourceId: "s1", name: "Greenhouse", status: "fetching" } });
      capturedOnEvent!({
        event: "jobPhase",
        data: { jobId: "j1", title: "Data Engineer", company: "Acme", source: "s1", phase: "scoring" },
      });
    });

    expect(await screen.findByText("Greenhouse")).toBeInTheDocument();
    expect(screen.getByText("Data Engineer")).toBeInTheDocument();
    expect(screen.queryByText("Discovering postings")).not.toBeInTheDocument();
  });

  it("refetches and renders ScanReplay once the live stream's done event fires", async () => {
    getScanDetail.mockResolvedValueOnce(runningDetail());
    render(<ScanDetailPage />);

    await waitFor(() => expect(subscribeSearch).toHaveBeenCalledWith("run-1", expect.any(Function)));

    getScanDetail.mockResolvedValueOnce(terminalDetail());
    act(() => {
      capturedOnEvent!({ event: "done", data: finishedSearchRun() });
    });

    await waitFor(() => expect(getScanDetail).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Discover")).toBeInTheDocument();
    expect(screen.queryByText("Discovering postings")).not.toBeInTheDocument();
  });
});
