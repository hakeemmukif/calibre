// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { reportClientError } = vi.hoisted(() => ({ reportClientError: vi.fn() }));
vi.mock("@/features/client-error/report", () => ({ reportClientError }));

import RootError from "./error";
import AppError from "./(app)/error";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("error boundaries (Task 4)", () => {
  const err = Object.assign(new Error("boom"), { digest: "d1" });

  it("root boundary reports the crash and offers retry + the operator's Telegram", () => {
    const reset = vi.fn();
    render(<RootError error={err} reset={reset} />);
    expect(reportClientError).toHaveBeenCalledWith(err);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reset).toHaveBeenCalledOnce();
    const link = screen.getByRole("link", { name: /telegram/i });
    expect(link).toHaveAttribute("href", expect.stringContaining("https://t.me/"));
  });

  it("(app) boundary reports and renders page-level framing (shell preserved by Next)", () => {
    render(<AppError error={err} reset={() => {}} />);
    expect(reportClientError).toHaveBeenCalledWith(err);
    expect(screen.getByText(/this page crashed/i)).toBeInTheDocument();
  });
});
