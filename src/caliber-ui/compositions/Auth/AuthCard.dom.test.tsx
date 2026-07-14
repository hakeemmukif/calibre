// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { AuthCard } from "./AuthCard";

// vitest.config.ts runs without `test.globals`, so @testing-library/react's
// automatic afterEach(cleanup) never registers — clean up explicitly.
afterEach(cleanup);

describe("AuthCard", () => {
  it("renders email + password inputs and a submit button for login mode", () => {
    render(
      <AuthCard mode="login" onSubmit={() => {}} busy={false} switchHref="/register" switchLabel="Create an account" />,
    );
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create an account" })).toHaveAttribute("href", "/register");
  });

  it("register mode shows the register title/cta", () => {
    render(
      <AuthCard mode="register" onSubmit={() => {}} busy={false} switchHref="/login" switchLabel="Sign in instead" />,
    );
    expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in instead" })).toHaveAttribute("href", "/login");
  });

  it("submit calls onSubmit with the entered email and password", () => {
    const onSubmit = vi.fn();
    render(
      <AuthCard mode="login" onSubmit={onSubmit} busy={false} switchHref="/register" switchLabel="Create an account" />,
    );
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.co" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter22" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSubmit).toHaveBeenCalledWith("a@b.co", "hunter22");
  });

  it("does not call onSubmit when email or password is empty", () => {
    const onSubmit = vi.fn();
    render(
      <AuthCard mode="login" onSubmit={onSubmit} busy={false} switchHref="/register" switchLabel="Create an account" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("renders the error message when the error prop is set", () => {
    render(
      <AuthCard
        mode="login"
        onSubmit={() => {}}
        busy={false}
        error="Invalid email or password."
        switchHref="/register"
        switchLabel="Create an account"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid email or password.");
  });

  it("busy disables the inputs and the submit button", () => {
    render(
      <AuthCard mode="login" onSubmit={() => {}} busy={true} switchHref="/register" switchLabel="Create an account" />,
    );
    expect(screen.getByLabelText("Email")).toBeDisabled();
    expect(screen.getByLabelText("Password")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Please wait…" })).toBeDisabled();
  });
});
