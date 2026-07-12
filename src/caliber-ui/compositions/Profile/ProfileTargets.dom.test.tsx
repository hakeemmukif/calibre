// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { ProfileTargets } from "./ProfileTargets";

// vitest.config.ts runs without `test.globals`, so @testing-library/react's
// automatic afterEach(cleanup) never registers — clean up explicitly.
afterEach(cleanup);

const profile = { baseCountry: "MY", relocation: "stay" as const, updatedAt: "2026-07-12T00:00:00.000Z" };

describe("ProfileTargets", () => {
  it("renders base country and both relocation options with stay selected", () => {
    render(<ProfileTargets profile={profile} busy={false} onRelocationChange={() => {}} />);
    expect(screen.getByText("Malaysia")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stay in Malaysia" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Open to relocate" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Malaysia jobs + remote roles that hire from Malaysia.")).toBeInTheDocument();
  });

  it("clicking the other option calls onRelocationChange with 'open'", () => {
    const onChange = vi.fn();
    render(<ProfileTargets profile={profile} busy={false} onRelocationChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Open to relocate" }));
    expect(onChange).toHaveBeenCalledWith("open");
  });

  it("shows the open caption when relocation is open", () => {
    render(<ProfileTargets profile={{ ...profile, relocation: "open" }} busy={false} onRelocationChange={() => {}} />);
    expect(screen.getByText("Also roles abroad that require relocating.")).toBeInTheDocument();
  });

  it("busy disables both options", () => {
    render(<ProfileTargets profile={profile} busy={true} onRelocationChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Stay in Malaysia" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open to relocate" })).toBeDisabled();
  });
});
