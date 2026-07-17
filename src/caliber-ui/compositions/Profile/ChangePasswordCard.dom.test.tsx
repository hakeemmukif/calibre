// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangePasswordCard } from "./ChangePasswordCard";

afterEach(cleanup);

describe("ChangePasswordCard (Task 6)", () => {
  it("submits current + new password when both are valid", () => {
    const onSubmit = vi.fn();
    render(<ChangePasswordCard onSubmit={onSubmit} busy={false} />);
    fireEvent.change(screen.getByLabelText(/current password/i), { target: { value: "old-password" } });
    fireEvent.change(screen.getByLabelText(/new password/i), { target: { value: "brand-new-pass" } });
    fireEvent.click(screen.getByRole("button", { name: /change password/i }));
    expect(onSubmit).toHaveBeenCalledWith("old-password", "brand-new-pass");
  });

  it("keeps the button disabled while the new password is under 8 chars", () => {
    render(<ChangePasswordCard onSubmit={() => {}} busy={false} />);
    fireEvent.change(screen.getByLabelText(/current password/i), { target: { value: "old" } });
    fireEvent.change(screen.getByLabelText(/new password/i), { target: { value: "short" } });
    expect(screen.getByRole("button", { name: /change password/i })).toBeDisabled();
  });

  it("shows the success line after a change", () => {
    render(<ChangePasswordCard onSubmit={() => {}} busy={false} success />);
    expect(screen.getByText(/other signed-in sessions were logged out/i)).toBeInTheDocument();
  });
});
