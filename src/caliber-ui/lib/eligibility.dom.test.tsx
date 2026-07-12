// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import { EligibilityTag } from "./eligibility";
import { jobs } from "../fixtures";

// vitest.config.ts runs without `test.globals`, so @testing-library/react's
// automatic afterEach(cleanup) never registers — clean up explicitly.
afterEach(cleanup);

const localJob = jobs.find((j) => j.eligibility.tier === "local");
const anywhereJob = jobs.find((j) => j.eligibility.tier === "anywhere");
if (!localJob || !anywhereJob) throw new Error("fixtures must cover local/anywhere tiers");

describe("EligibilityTag (spec §8)", () => {
  it("renders nothing for the local tier — suppression is the component's own rule", () => {
    const { container } = render(<EligibilityTag eligibility={localJob.eligibility} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders label and title for a non-local tier", () => {
    render(<EligibilityTag eligibility={anywhereJob.eligibility} />);
    const pill = screen.getByText("Work anywhere");
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveAttribute("title", anywhereJob.eligibility.summary);
  });
});
