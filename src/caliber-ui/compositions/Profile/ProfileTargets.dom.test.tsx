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
  displayLocation: null,
  targetRole: null,
  salaryMin: null,
  salaryMax: null,
  salaryCurrency: null,
  salaryCadence: null,
  attrProvenance: {},
  updatedAt: "2026-07-12T00:00:00.000Z",
};

const noop = () => {};

describe("ProfileTargets", () => {
  it("renders base country and both relocation options with stay selected", () => {
    render(
      <ProfileTargets
        profile={profile}
        busy={false}
        onRelocationChange={noop}
        onScheduleChange={noop}
        onEmploymentChange={noop}
        onPresetSelect={noop}
      />,
    );
    expect(screen.getByText("Malaysia")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stay in Malaysia" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Open to relocate" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Malaysia jobs + remote roles that hire from Malaysia.")).toBeInTheDocument();
  });

  it("clicking the other option calls onRelocationChange with 'open'", () => {
    const onChange = vi.fn();
    render(
      <ProfileTargets
        profile={profile}
        busy={false}
        onRelocationChange={onChange}
        onScheduleChange={noop}
        onEmploymentChange={noop}
        onPresetSelect={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open to relocate" }));
    expect(onChange).toHaveBeenCalledWith("open");
  });

  it("shows the open caption when relocation is open", () => {
    render(
      <ProfileTargets
        profile={{ ...profile, relocation: "open" }}
        busy={false}
        onRelocationChange={noop}
        onScheduleChange={noop}
        onEmploymentChange={noop}
        onPresetSelect={noop}
      />,
    );
    expect(screen.getByText("Also roles abroad that require relocating.")).toBeInTheDocument();
  });

  it("busy disables relocation, schedule, and employment options", () => {
    render(
      <ProfileTargets
        profile={profile}
        busy={true}
        onRelocationChange={noop}
        onScheduleChange={noop}
        onEmploymentChange={noop}
        onPresetSelect={noop}
      />,
    );
    expect(screen.getByRole("button", { name: "Stay in Malaysia" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open to relocate" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Malaysia hours" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Any hours — US overlap" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Any arrangement" })).toBeDisabled();
  });

  it("renders schedule + employment controls with current selection", () => {
    render(
      <ProfileTargets
        profile={profile}
        busy={false}
        onRelocationChange={noop}
        onScheduleChange={noop}
        onEmploymentChange={noop}
        onPresetSelect={noop}
      />,
    );
    expect(screen.getByRole("button", { name: "Any hours — US overlap" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Any arrangement" })).toHaveAttribute("aria-pressed", "true");
  });

  it("clicking a schedule level calls onScheduleChange", () => {
    const onSchedule = vi.fn();
    render(
      <ProfileTargets
        profile={profile}
        busy={false}
        onRelocationChange={noop}
        onScheduleChange={onSchedule}
        onEmploymentChange={noop}
        onPresetSelect={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Malaysia hours" }));
    expect(onSchedule).toHaveBeenCalledWith("base-hours");
  });

  it("clicking an employment level calls onEmploymentChange", () => {
    const onEmployment = vi.fn();
    render(
      <ProfileTargets
        profile={profile}
        busy={false}
        onRelocationChange={noop}
        onScheduleChange={noop}
        onEmploymentChange={onEmployment}
        onPresetSelect={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Malaysian entity only" }));
    expect(onEmployment).toHaveBeenCalledWith("local-entity");
  });

  // Deviation from the brief's DOM-test sketch: the brief's step 2 asserted a
  // preset click calls onRelocationChange/onScheduleChange/onEmploymentChange
  // individually. That shape would make the PAGE fire three independent PUTs
  // off one stale `profile` snapshot, which race on the singleton row and
  // silently drop two of the three dials. ProfileTargets instead exposes a
  // single onPresetSelect(bundle) prop so the page can issue ONE atomic PUT.
  it("a preset card sets all three dials via a single onPresetSelect call", () => {
    const onPresetSelect = vi.fn();
    render(
      <ProfileTargets
        profile={profile}
        busy={false}
        onRelocationChange={noop}
        onScheduleChange={noop}
        onEmploymentChange={noop}
        onPresetSelect={onPresetSelect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Global remote/ }));
    expect(onPresetSelect).toHaveBeenCalledTimes(1);
    expect(onPresetSelect).toHaveBeenCalledWith({ relocation: "stay", scheduleFlex: "flex-evenings", employmentPref: "any" });
  });

  it("derives the selected preset ring from the current dials (no preset is stored)", () => {
    render(
      <ProfileTargets
        profile={profile}
        busy={false}
        onRelocationChange={noop}
        onScheduleChange={noop}
        onEmploymentChange={noop}
        onPresetSelect={noop}
      />,
    );
    // profile = stay · any-hours · any === the "Digital nomad" bundle.
    expect(screen.getByRole("button", { name: /Digital nomad/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Global remote/ })).toHaveAttribute("aria-pressed", "false");
  });
});
