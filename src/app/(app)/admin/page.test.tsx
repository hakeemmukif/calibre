// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { ApiError } from "@/features/http";
import type { AdminUser, SourcesHealthResponse } from "@/types";

afterEach(cleanup);

const { getAdminUsers, getSourcesHealth, grantCredits, patchUserPlan } = vi.hoisted(() => ({
  getAdminUsers: vi.fn(),
  getSourcesHealth: vi.fn(),
  grantCredits: vi.fn(),
  patchUserPlan: vi.fn(),
}));
vi.mock("@/features/admin/client", () => ({
  getAdminUsers,
  getSourcesHealth,
  grantCredits,
  patchUserPlan,
}));

import AdminPage from "./page";

const users: AdminUser[] = [
  {
    id: "u1",
    email: "admin@caliber.dev",
    role: "admin",
    createdAt: "2026-01-05T09:00:00.000Z",
    resumeCount: 1,
    jobCount: 42,
    applicationCount: 12,
    balance: 0,
    plan: "unlimited",
  },
];

const emptySourcesHealth: SourcesHealthResponse = { total: 0, enabledCount: 0, deadCount: 0, items: [] };

beforeEach(() => {
  getAdminUsers.mockReset();
  getSourcesHealth.mockReset();
  getSourcesHealth.mockResolvedValue(emptySourcesHealth);
});

describe("AdminPage load", () => {
  it("renders the users table once the client resolves", async () => {
    getAdminUsers.mockResolvedValue(users);
    render(<AdminPage />);

    expect(await screen.findByText("admin@caliber.dev")).toBeInTheDocument();
  });

  it("shows the empty state when there are no users", async () => {
    getAdminUsers.mockResolvedValue([]);
    render(<AdminPage />);

    expect(await screen.findByText(/no users/i)).toBeInTheDocument();
  });
});

describe("AdminPage forbidden", () => {
  it("shows a no-access state on a 403, not the generic error banner", async () => {
    getAdminUsers.mockRejectedValue(new ApiError(403, "FORBIDDEN", "Admins only."));
    render(<AdminPage />);

    expect(await screen.findByText(/do not have access/i)).toBeInTheDocument();
    expect(screen.queryByText("Admins only.")).not.toBeInTheDocument();
  });
});

describe("AdminPage generic error", () => {
  it("shows the error message and a Retry that reloads", async () => {
    getAdminUsers.mockRejectedValue(new Error("Couldn't load users."));
    render(<AdminPage />);

    expect(await screen.findByText("Couldn't load users.")).toBeInTheDocument();

    getAdminUsers.mockResolvedValue(users);
    screen.getByRole("button", { name: /retry/i }).click();

    await waitFor(() => expect(getAdminUsers).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("admin@caliber.dev")).toBeInTheDocument();
  });
});

describe("AdminPage sources health", () => {
  it("renders the total/enabled/dead counts and the dead/disabled rows list", async () => {
    getAdminUsers.mockResolvedValue(users);
    getSourcesHealth.mockResolvedValue({
      total: 4,
      enabledCount: 2,
      deadCount: 1,
      items: [
        {
          id: "lever:defunct",
          name: "Defunct Co",
          enabled: false,
          status: "dead",
          consecutiveFailures: 6,
          lastValidatedAt: 1_752_600_000_000,
          jobCount: 0,
          provenance: ["jobhive"],
        },
        // hand-curated row: admin-disabled but no health fields at all —
        // must render without throwing and without fabricating a status.
        { id: "gh-curated-off", name: "Curated Off", enabled: false },
      ],
    });
    render(<AdminPage />);

    expect(await screen.findByText("Sources health")).toBeInTheDocument();
    expect(await screen.findByText("Defunct Co")).toBeInTheDocument();
    expect(screen.getByText("dead")).toBeInTheDocument();
    expect(screen.getByText("Curated Off")).toBeInTheDocument();
    expect(screen.getByText("disabled")).toBeInTheDocument();

    // the three stat tiles (scoped to their own Card so "1"/"2" don't
    // collide with the unrelated résumé/job counts in the users table)
    expect(within(screen.getByText("Total").parentElement!).getByText("4")).toBeInTheDocument();
    expect(within(screen.getByText("Enabled").parentElement!).getByText("2")).toBeInTheDocument();
    expect(within(screen.getByText("Dead").parentElement!).getByText("1")).toBeInTheDocument();
  });

  it("shows the empty state when there are no dead or disabled sources", async () => {
    getAdminUsers.mockResolvedValue(users);
    getSourcesHealth.mockResolvedValue({ total: 3, enabledCount: 3, deadCount: 0, items: [] });
    render(<AdminPage />);

    expect(await screen.findByText(/no dead or disabled sources/i)).toBeInTheDocument();
  });

  it("renders a row's `error` as a danger tag with its message, without fabricating a status", async () => {
    getAdminUsers.mockResolvedValue(users);
    getSourcesHealth.mockResolvedValue({
      total: 1,
      enabledCount: 1,
      deadCount: 0,
      items: [{ id: "gh:broken", name: "Broken", enabled: true, error: "admin/sources: engine source malformed" }],
    });
    render(<AdminPage />);

    expect(await screen.findByText("error")).toBeInTheDocument();
    expect(screen.getByText("admin/sources: engine source malformed")).toBeInTheDocument();
  });

  it("degrades to a panel-local error when getSourcesHealth rejects, without blanking the users table", async () => {
    getAdminUsers.mockResolvedValue(users);
    getSourcesHealth.mockRejectedValue(new Error("sources health boom"));
    render(<AdminPage />);

    expect(await screen.findByText("admin@caliber.dev")).toBeInTheDocument();
    expect(await screen.findByText(/couldn't load sources health/i)).toBeInTheDocument();
    expect(screen.getByText(/sources health boom/)).toBeInTheDocument();
  });
});
