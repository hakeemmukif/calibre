// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { JobTargets } from "./JobTargets";
import type { Profile } from "../../../types";

// vitest.config.ts runs without `test.globals`, so @testing-library/react's
// automatic afterEach(cleanup) never registers — clean up explicitly.
afterEach(cleanup);

const profile: Profile = {
  baseCountry: "MY",
  relocation: "stay",
  scheduleFlex: "any-hours",
  employmentPref: "any",
  displayLocation: "Kuala Lumpur, Malaysia",
  targetRole: "Backend Engineer",
  salaryMin: 8000,
  salaryMax: 12000,
  salaryCurrency: "MYR",
  salaryCadence: "monthly",
  attrProvenance: { displayLocation: "resume", targetRole: "user", salary: "user" },
  updatedAt: "2026-07-22T00:00:00.000Z",
};

const noop = () => {};

describe("JobTargets", () => {
  // Bug fix pin (reviewer Critical, resync-on-reference clobbered unsaved
  // drafts): a sibling save (e.g. ProfileTargets's dial chips) produces a
  // new `profile` object whose six attribute VALUES are unchanged — the
  // draft must survive that rerender.
  it("keeps unsaved draft text when profile is replaced but attribute values are unchanged", () => {
    const { rerender } = render(<JobTargets profile={profile} busy={false} onSave={noop} />);
    const input = screen.getByPlaceholderText("e.g. Backend Engineer") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Senior Backend Engineer" } });
    expect(input.value).toBe("Senior Backend Engineer");

    // A different profile object, e.g. after a relocation-dial save — same
    // six attribute values, different reference (and a changed unrelated field).
    rerender(<JobTargets profile={{ ...profile, relocation: "open" }} busy={false} onSave={noop} />);

    expect(screen.getByPlaceholderText("e.g. Backend Engineer")).toHaveValue("Senior Backend Engineer");
  });

  it("resyncs the draft when an attribute value actually changes", () => {
    const { rerender } = render(<JobTargets profile={profile} busy={false} onSave={noop} />);
    const input = screen.getByPlaceholderText("e.g. Backend Engineer") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Senior Backend Engineer" } });
    expect(input.value).toBe("Senior Backend Engineer");

    rerender(<JobTargets profile={{ ...profile, targetRole: "Staff Engineer" }} busy={false} onSave={noop} />);

    expect(screen.getByPlaceholderText("e.g. Backend Engineer")).toHaveValue("Staff Engineer");
  });

  it("disables Save until the draft is dirty and valid", () => {
    render(<JobTargets profile={profile} busy={false} onSave={noop} />);
    expect(screen.getByRole("button", { name: "Save targets" })).toBeDisabled();
  });

  it("enables Save once a field is edited, and calls onSave with the normalized fields", () => {
    const onSave = vi.fn();
    render(<JobTargets profile={profile} busy={false} onSave={onSave} />);
    fireEvent.change(screen.getByPlaceholderText("e.g. Backend Engineer"), { target: { value: "Staff Engineer" } });
    const saveButton = screen.getByRole("button", { name: "Save targets" });
    expect(saveButton).not.toBeDisabled();
    fireEvent.click(saveButton);
    expect(onSave).toHaveBeenCalledWith({
      displayLocation: "Kuala Lumpur, Malaysia",
      targetRole: "Staff Engineer",
      salaryMin: 8000,
      salaryMax: 12000,
      salaryCurrency: "MYR",
      salaryCadence: "monthly",
    });
  });

  it("shows provenance hints from attrProvenance", () => {
    render(<JobTargets profile={profile} busy={false} onSave={noop} />);
    expect(screen.getByText("from résumé")).toBeInTheDocument();
    expect(screen.getAllByText("edited").length).toBeGreaterThan(0);
  });

  it("busy disables inputs and Save", () => {
    render(<JobTargets profile={profile} busy={true} onSave={noop} />);
    expect(screen.getByPlaceholderText("e.g. Backend Engineer")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save targets" })).toBeDisabled();
  });
});
