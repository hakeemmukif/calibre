// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import { JobRow } from "./JobRow";
import { jobs } from "../../fixtures";

// vitest.config.ts runs without `test.globals`, so @testing-library/react's
// automatic afterEach(cleanup) never registers — clean up explicitly.
afterEach(cleanup);

const noop = () => {};

const anywhereJob = jobs.find((j) => j.eligibility.tier === "anywhere");
const unknownJob = jobs.find((j) => j.eligibility.tier === "unknown");
const localJob = jobs.find((j) => j.eligibility.tier === "local");
if (!anywhereJob || !unknownJob || !localJob) throw new Error("fixtures must cover anywhere/unknown/local tiers");

describe("JobRow eligibility pill (spec §8)", () => {
  it("renders the 'Work anywhere' pill for the anywhere tier", () => {
    render(<JobRow job={anywhereJob} onOpen={noop} onSave={noop} onDismiss={noop} />);
    expect(screen.getByText("Work anywhere")).toBeInTheDocument();
  });

  it("renders the warn 'Eligibility unverified' pill for the unknown tier", () => {
    render(<JobRow job={unknownJob} onOpen={noop} onSave={noop} onDismiss={noop} />);
    expect(screen.getByText("Eligibility unverified")).toBeInTheDocument();
  });

  it("suppresses the pill for the local tier — no 'Malaysia' noise on MY rows", () => {
    render(<JobRow job={localJob} onOpen={noop} onSave={noop} onDismiss={noop} />);
    expect(screen.queryByText("Malaysia")).not.toBeInTheDocument();
  });
});

describe("JobRow neutral schedule/structure pills (remote-fit spec §11, D2)", () => {
  it("renders a neutral 'US hours' tag when the assembled job carries one", () => {
    const job = { ...anywhereJob, tags: [...anywhereJob.tags, { tone: "neutral" as const, label: "US hours" }] };
    render(<JobRow job={job} onOpen={noop} onSave={noop} onDismiss={noop} />);
    expect(screen.getByText("US hours")).toBeInTheDocument();
  });

  it("renders no schedule pill when tzBand is null or apac (no neutral tag on the job)", () => {
    render(<JobRow job={anywhereJob} onOpen={noop} onSave={noop} onDismiss={noop} />);
    expect(screen.queryByText("US hours")).not.toBeInTheDocument();
    expect(screen.queryByText("EU hours")).not.toBeInTheDocument();
  });
});
