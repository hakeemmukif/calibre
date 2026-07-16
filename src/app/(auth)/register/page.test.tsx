// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

afterEach(cleanup);

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

const { register } = vi.hoisted(() => ({ register: vi.fn() }));
vi.mock("@/features/auth/client", () => ({ register }));

import RegisterPage from "./page";

beforeEach(() => {
  push.mockReset();
  register.mockReset();
});

describe("RegisterPage", () => {
  it("submits the entered credentials, calls register(), and redirects to '/' on success", async () => {
    register.mockResolvedValue({ id: "u1", email: "new@b.co", role: "user" });
    render(<RegisterPage />);

    fireEvent.change(screen.getByLabelText("Invite code"), { target: { value: "e2e-invite" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@b.co" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "longenough" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() =>
      expect(register).toHaveBeenCalledWith({ email: "new@b.co", password: "longenough", inviteCode: "e2e-invite" }),
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
  });

  it("shows the server error message verbatim and does not redirect on failure (e.g. duplicate email)", async () => {
    register.mockRejectedValue(new Error("An account with this email already exists."));
    render(<RegisterPage />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "dup@b.co" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "longenough" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("An account with this email already exists.")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("links to /login", () => {
    register.mockResolvedValue({ id: "u1", email: "new@b.co", role: "user" });
    render(<RegisterPage />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/login");
  });
});
