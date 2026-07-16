// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { ApiError } from "@/features/http";
import type { AdminUser } from "@/types";

afterEach(cleanup);

const { getAdminUsers, grantCredits, patchUserPlan } = vi.hoisted(() => ({
  getAdminUsers: vi.fn(),
  grantCredits: vi.fn(),
  patchUserPlan: vi.fn(),
}));
vi.mock("@/features/admin/client", () => ({ getAdminUsers, grantCredits, patchUserPlan }));

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

beforeEach(() => {
  getAdminUsers.mockReset();
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
