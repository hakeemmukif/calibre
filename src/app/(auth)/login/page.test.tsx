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

const { login } = vi.hoisted(() => ({ login: vi.fn() }));
vi.mock("@/features/auth/client", () => ({ login }));

import LoginPage from "./page";

beforeEach(() => {
  push.mockReset();
  login.mockReset();
});

describe("LoginPage", () => {
  it("submits the entered credentials, calls login(), and redirects to '/' on success", async () => {
    login.mockResolvedValue({ id: "u1", email: "a@b.co", role: "user" });
    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.co" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter22" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(login).toHaveBeenCalledWith({ email: "a@b.co", password: "hunter22" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
  });

  it("shows the server error message verbatim and does not redirect on failure", async () => {
    login.mockRejectedValue(new Error("Invalid email or password."));
    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.co" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Invalid email or password.")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("links to /register", () => {
    login.mockResolvedValue({ id: "u1", email: "a@b.co", role: "user" });
    render(<LoginPage />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/register");
  });
});
