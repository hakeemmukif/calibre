// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

afterEach(cleanup);

const push = vi.fn();
let pathname = "/feed";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => pathname,
}));

const { logout } = vi.hoisted(() => ({ logout: vi.fn() }));
vi.mock("@/features/auth/client", () => ({ logout }));

const { __resetChecksStore } = vi.hoisted(() => ({ __resetChecksStore: vi.fn() }));
vi.mock("@/features/url-check/checksStore", () => ({ __resetChecksStore }));

vi.mock("@/caliber-ui/compositions/Shell/CheckDock", () => ({ CheckDock: () => null }));

import { AppShell } from "./AppShell";

const user = { id: "u1", email: "alex@caliber.dev", role: "user" as const };
const admin = { id: "u2", email: "root@caliber.dev", role: "admin" as const };

beforeEach(() => {
  push.mockReset();
  logout.mockReset();
  logout.mockResolvedValue(undefined);
  __resetChecksStore.mockReset();
  pathname = "/feed";
});

describe("AppShell", () => {
  it("renders the real user's email and role in the ProfileChip, never a fake name", () => {
    render(<AppShell user={user}>content</AppShell>);
    expect(screen.getByText("alex@caliber.dev")).toBeInTheDocument();
    expect(screen.getByText("user")).toBeInTheDocument();
    expect(screen.queryByText("Alex Tan")).not.toBeInTheDocument();
  });

  it("renders nothing in the footer when there is no user", () => {
    render(<AppShell>content</AppShell>);
    expect(screen.queryByRole("button", { name: "Log out" })).not.toBeInTheDocument();
  });

  it("does not render the Admin nav group for a non-admin user", () => {
    render(<AppShell user={user}>content</AppShell>);
    expect(screen.queryByText("Admin")).not.toBeInTheDocument();
    expect(screen.queryByText("Users")).not.toBeInTheDocument();
  });

  it("renders the Admin nav group for an admin user", () => {
    render(<AppShell user={admin}>content</AppShell>);
    expect(screen.getByText("Admin")).toBeInTheDocument();
    expect(screen.getByText("Users")).toBeInTheDocument();
  });

  it("lights up the admin-users nav row when the route is under /admin", () => {
    pathname = "/admin";
    render(<AppShell user={admin}>content</AppShell>);
    const usersRow = screen.getByText("Users").closest("button");
    expect(usersRow).toHaveTextContent("Users");
  });

  it("navigates to /admin when the Users row is clicked", () => {
    render(<AppShell user={admin}>content</AppShell>);
    fireEvent.click(screen.getByText("Users"));
    expect(push).toHaveBeenCalledWith("/admin");
  });

  it("clicking logout calls logout(), resets the checks store, then redirects to /login", async () => {
    render(<AppShell user={user}>content</AppShell>);
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));

    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(__resetChecksStore).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/login"));
  });

  it("still resets the checks store and redirects to /login when logout() rejects", async () => {
    logout.mockRejectedValue(new Error("401"));
    render(<AppShell user={user}>content</AppShell>);
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));

    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(__resetChecksStore).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/login"));
  });

  it("resets the checks store when the signed-in user id changes", () => {
    const { rerender } = render(<AppShell user={user}>content</AppShell>);
    expect(__resetChecksStore).not.toHaveBeenCalled();

    rerender(<AppShell user={admin}>content</AppShell>);
    expect(__resetChecksStore).toHaveBeenCalledTimes(1);
  });

  it("does not reset the checks store on initial mount or a same-user rerender", () => {
    const { rerender } = render(<AppShell user={user}>content</AppShell>);
    rerender(<AppShell user={{ ...user }}>content</AppShell>);
    expect(__resetChecksStore).not.toHaveBeenCalled();
  });
});
