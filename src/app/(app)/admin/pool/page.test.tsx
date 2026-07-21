// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { ApiError } from "@/features/http";
import type { AdminPoolStats } from "@/types";

afterEach(cleanup);

const { getPoolStats } = vi.hoisted(() => ({ getPoolStats: vi.fn() }));
vi.mock("@/features/admin/client", () => ({ getPoolStats }));

import AdminPoolPage from "./page";

const stats: AdminPoolStats = {
  totals: { live: 10, delisted: 1, newLast24h: 2, sourcesEnabled: 3, sourcesTotal: 4, tagCoveragePct: 10 },
  functionMix: [{ bucket: "engineering", count: 10, share: 100, source: "keyword" }],
  tzBands: [
    { band: "americas", count: 10, share: 100 },
    { band: "emea", count: 0, share: 0 },
    { band: "apac", count: 0, share: 0 },
    { band: "unassigned", count: 0, share: 0 },
  ],
  freshness: [
    { bucket: "24h", count: 2 },
    { bucket: "2-7d", count: 3 },
    { bucket: "8-30d", count: 3 },
    { bucket: "older", count: 2 },
  ],
  concentration: { topCompanies: [{ company: "Acme", count: 10 }], top10Count: 10, restCount: 0 },
};

beforeEach(() => {
  getPoolStats.mockReset();
});

describe("AdminPoolPage load", () => {
  it("renders the tile row once the client resolves", async () => {
    getPoolStats.mockResolvedValue(stats);
    render(<AdminPoolPage />);

    expect(await screen.findByText("Live postings")).toBeInTheDocument();
  });
});

describe("AdminPoolPage forbidden", () => {
  it("shows a no-access state on a 403, not the generic error banner", async () => {
    getPoolStats.mockRejectedValue(new ApiError(403, "FORBIDDEN", "Admins only."));
    render(<AdminPoolPage />);

    expect(await screen.findByText(/do not have access/i)).toBeInTheDocument();
    expect(screen.queryByText("Admins only.")).not.toBeInTheDocument();
  });
});

describe("AdminPoolPage generic error", () => {
  it("shows the error message and a Retry that reloads", async () => {
    getPoolStats.mockRejectedValue(new Error("Couldn't load pool stats."));
    render(<AdminPoolPage />);

    expect(await screen.findByText("Couldn't load pool stats.")).toBeInTheDocument();

    getPoolStats.mockResolvedValue(stats);
    screen.getByRole("button", { name: /retry/i }).click();

    await waitFor(() => expect(getPoolStats).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Live postings")).toBeInTheDocument();
  });
});
