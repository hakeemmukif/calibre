// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { ApiError } from "@/features/http";
import type { AdminCrawlStatus } from "@/types";

afterEach(cleanup);

const { getCrawlStatus } = vi.hoisted(() => ({
  getCrawlStatus: vi.fn(),
}));
vi.mock("@/features/admin/client", () => ({ getCrawlStatus }));

import AdminCrawlPage from "./page";

beforeEach(() => {
  getCrawlStatus.mockReset();
});

describe("AdminCrawlPage forbidden", () => {
  it("shows a no-access state on a 403, not the generic error banner", async () => {
    getCrawlStatus.mockRejectedValue(new ApiError(403, "FORBIDDEN", "Admins only."));
    render(<AdminCrawlPage />);

    expect(await screen.findByText(/do not have access/i)).toBeInTheDocument();
    expect(screen.queryByText("Admins only.")).not.toBeInTheDocument();
  });
});

describe("AdminCrawlPage crawl status", () => {
  it("renders the live pool count, staleness chip, and last-runs table", async () => {
    getCrawlStatus.mockResolvedValue({
      pool: { live: 1234, delisted: 56, total: 1290 },
      staleness: 5,
      runningCrawl: null,
      lastRuns: [
        {
          status: "completed",
          startedAt: "2026-07-16T03:00:00.000Z",
          finishedAt: "2026-07-16T03:10:00.000Z",
          durationMs: 600_000,
          sourcesOk: 2,
          sourcesFailed: 1,
          skipped: 3,
          upserts: 40,
          delists: 2,
          perHostBackoffs: {},
          emptyFetches: ["gh:stale-slug"],
        },
      ],
      perSource: { items: [{ sourceId: "gh:quiet", name: "Quiet Co", liveCount: 0, lastSeenAt: null }], totalSources: 5 },
      errors: [],
    } satisfies AdminCrawlStatus);
    render(<AdminCrawlPage />);

    expect(await screen.findByText("Crawl")).toBeInTheDocument();
    expect(screen.getByText("1,234")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument(); // skipped, rendered red
    expect(screen.getByText("gh:stale-slug")).toBeInTheDocument();
    expect(screen.getByText(/upserts = churn, not growth/)).toBeInTheDocument();
    expect(screen.getByText("Quiet Co")).toBeInTheDocument();
  });

  it("shows the error message and a Retry that reloads", async () => {
    getCrawlStatus.mockRejectedValue(new Error("crawl status boom"));
    render(<AdminCrawlPage />);

    expect(await screen.findByText("crawl status boom")).toBeInTheDocument();

    getCrawlStatus.mockResolvedValue({
      pool: { live: 0, delisted: 0, total: 0 },
      staleness: null,
      runningCrawl: null,
      lastRuns: [],
      perSource: { items: [], totalSources: 0 },
      errors: [],
    } satisfies AdminCrawlStatus);
    screen.getByRole("button", { name: /retry/i }).click();

    expect(await screen.findByText("Crawl")).toBeInTheDocument();
  });
});
