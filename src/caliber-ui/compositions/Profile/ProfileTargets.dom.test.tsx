// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { ProfileTargets } from "./ProfileTargets";

// vitest.config.ts runs without `test.globals`, so @testing-library/react's
// automatic afterEach(cleanup) never registers — clean up explicitly.
afterEach(cleanup);

const profile = {
  baseCountry: "MY",
  relocation: "stay" as const,
  scheduleFlex: "any-hours" as const,
  employmentPref: "any" as const,
  updatedAt: "2026-07-12T00:00:00.000Z",
};

const noop = {
  onRelocationChange: () => {},
  onScheduleChange: () => {},
  onEmploymentChange: () => {},
  onPresetSelect: () => {},
};

describe("ProfileTargets", () => {
  it("renders base country and both relocation options with stay selected", () => {
    render(<ProfileTargets profile={profile} busy={false} {...noop} />);
    expect(screen.getByText("Malaysia")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stay in Malaysia" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Open to relocate" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Malaysia jobs + remote roles that hire from Malaysia.")).toBeInTheDocument();
  });

  it("clicking the other relocation option calls onRelocationChange with 'open'", () => {
    const onChange = vi.fn();
    render(<ProfileTargets profile={profile} busy={false} {...noop} onRelocationChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Open to relocate" }));
    expect(onChange).toHaveBeenCalledWith("open");
  });

  it("shows the open caption when relocation is open", () => {
    render(<ProfileTargets profile={{ ...profile, relocation: "open" }} busy={false} {...noop} />);
    expect(screen.getByText("Also roles abroad that require relocating.")).toBeInTheDocument();
  });

  it("busy disables both relocation options", () => {
    render(<ProfileTargets profile={profile} busy={true} {...noop} />);
    expect(screen.getByRole("button", { name: "Stay in Malaysia" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open to relocate" })).toBeDisabled();
  });

  it("renders the three schedule options with any-hours selected, and clicking one calls onScheduleChange", () => {
    const onChange = vi.fn();
    render(<ProfileTargets profile={profile} busy={false} {...noop} onScheduleChange={onChange} />);
    expect(screen.getByRole("button", { name: "Malaysia hours" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Evenings OK — Europe overlap" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Any hours — US overlap" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Malaysia hours" }));
    expect(onChange).toHaveBeenCalledWith("base-hours");
  });

  it("renders the three employment options with any selected, and clicking one calls onEmploymentChange", () => {
    const onChange = vi.fn();
    render(<ProfileTargets profile={profile} busy={false} {...noop} onEmploymentChange={onChange} />);
    expect(screen.getByRole("button", { name: "Any arrangement" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Employee — EOR OK" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Malaysian entity only" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: "Malaysian entity only" }));
    expect(onChange).toHaveBeenCalledWith("local-entity");
  });

  it("clicking the 'Global remote' preset calls onPresetSelect with the bundled dials", () => {
    const onPresetSelect = vi.fn();
    render(<ProfileTargets profile={profile} busy={false} {...noop} onPresetSelect={onPresetSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "Preset: Global remote" }));
    expect(onPresetSelect).toHaveBeenCalledWith({ relocation: "stay", scheduleFlex: "flex-evenings", employmentPref: "any" });
  });

  it("busy disables the schedule, employment, and preset controls", () => {
    const onPresetSelect = vi.fn();
    render(<ProfileTargets profile={profile} busy={true} {...noop} onPresetSelect={onPresetSelect} />);
    expect(screen.getByRole("button", { name: "Malaysia hours" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Any arrangement" })).toBeDisabled();

    const presetButton = screen.getByRole("button", { name: "Preset: Global remote" });
    expect(presetButton).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(presetButton);
    expect(onPresetSelect).not.toHaveBeenCalled();
  });
});
