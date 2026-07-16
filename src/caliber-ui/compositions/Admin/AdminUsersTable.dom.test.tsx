// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { AdminUsersTable } from "./AdminUsersTable";
import type { AdminUser } from "../../../types";

afterEach(cleanup);

const noop = () => {};

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
  {
    id: "u2",
    email: "alice@example.com",
    role: "user",
    createdAt: "2026-02-14T09:00:00.000Z",
    resumeCount: 0,
    jobCount: 3,
    applicationCount: 1,
    balance: 20,
    plan: "standard",
  },
];

describe("AdminUsersTable rows", () => {
  it("renders each user's email, role, and counts", () => {
    render(<AdminUsersTable users={users} onGrant={noop} onTogglePlan={noop} />);

    expect(screen.getByText("admin@caliber.dev")).toBeInTheDocument();
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getByText("admin")).toBeInTheDocument();
    expect(screen.getByText("user")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("renders each row's balance and a plan chip", () => {
    render(<AdminUsersTable users={users} onGrant={noop} onTogglePlan={noop} />);

    expect(screen.getByText("20")).toBeInTheDocument();
    expect(screen.getByText("unlimited")).toBeInTheDocument();
    expect(screen.getByText("standard")).toBeInTheDocument();
  });

  it("clicking +150 calls onGrant with the row's id and 150", () => {
    const onGrant = vi.fn();
    render(<AdminUsersTable users={users} onGrant={onGrant} onTogglePlan={noop} />);

    const [firstGrantButton] = screen.getAllByRole("button", { name: /\+150/i });
    fireEvent.click(firstGrantButton);

    expect(onGrant).toHaveBeenCalledWith("u1", 150);
  });

  it("clicking the plan toggle calls onTogglePlan with the flipped plan", () => {
    const onTogglePlan = vi.fn();
    render(<AdminUsersTable users={users} onGrant={noop} onTogglePlan={onTogglePlan} />);

    fireEvent.click(screen.getByRole("button", { name: /make unlimited/i }));
    expect(onTogglePlan).toHaveBeenCalledWith("u2", "unlimited");

    fireEvent.click(screen.getByRole("button", { name: /make standard/i }));
    expect(onTogglePlan).toHaveBeenCalledWith("u1", "standard");
  });
});

describe("AdminUsersTable empty state", () => {
  it("shows an empty message and no table when there are no users", () => {
    render(<AdminUsersTable users={[]} onGrant={noop} onTogglePlan={noop} />);

    expect(screen.getByText(/no users/i)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
