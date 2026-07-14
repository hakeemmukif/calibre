// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import { AdminUsersTable } from "./AdminUsersTable";
import type { AdminUser } from "../../../types";

afterEach(cleanup);

const users: AdminUser[] = [
  {
    id: "u1",
    email: "admin@caliber.dev",
    role: "admin",
    createdAt: "2026-01-05T09:00:00.000Z",
    resumeCount: 1,
    jobCount: 42,
    applicationCount: 12,
  },
  {
    id: "u2",
    email: "alice@example.com",
    role: "user",
    createdAt: "2026-02-14T09:00:00.000Z",
    resumeCount: 0,
    jobCount: 3,
    applicationCount: 1,
  },
];

describe("AdminUsersTable rows", () => {
  it("renders each user's email, role, and counts", () => {
    render(<AdminUsersTable users={users} />);

    expect(screen.getByText("admin@caliber.dev")).toBeInTheDocument();
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getByText("admin")).toBeInTheDocument();
    expect(screen.getByText("user")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });
});

describe("AdminUsersTable empty state", () => {
  it("shows an empty message and no table when there are no users", () => {
    render(<AdminUsersTable users={[]} />);

    expect(screen.getByText(/no users/i)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
