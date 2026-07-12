// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import { EvalResultCard } from "./EvalResultCard";
import { jobs } from "../../fixtures";

afterEach(cleanup);

const noop = () => {};

const anywhereJob = jobs.find((j) => j.eligibility.tier === "anywhere");
if (!anywhereJob) throw new Error("fixtures must cover the anywhere tier");

describe("EvalResultCard eligibility tag (spec §12)", () => {
  it("renders the eligibility pill alongside the legitimacy pill", () => {
    render(<EvalResultCard job={anywhereJob} onOpen={noop} onSave={noop} onTailor={noop} onDismiss={noop} />);
    expect(screen.getByText("Work anywhere")).toBeInTheDocument();
  });
});

const okJob = {
  ...anywhereJob,
  legitimacy: {
    ...anywhereJob.legitimacy,
    webEvidence: {
      status: "ok" as const,
      sightings: [],
      companySignals: [],
      summary: "Confirmed live on 2 job boards, posted 4 days ago.",
      confidence: 0.8,
    },
  },
};

const failedJob = {
  ...anywhereJob,
  legitimacy: {
    ...anywhereJob.legitimacy,
    webEvidence: { status: "failed" as const, reason: "search provider timeout" },
  },
};

describe("EvalResultCard web evidence line (spec §12)", () => {
  it("renders the web evidence summary when the check succeeded", () => {
    render(<EvalResultCard job={okJob} onOpen={noop} onSave={noop} onTailor={noop} onDismiss={noop} />);
    expect(screen.getByText("Confirmed live on 2 job boards, posted 4 days ago.")).toBeInTheDocument();
  });

  it("renders the fallback line when the web check failed", () => {
    render(<EvalResultCard job={failedJob} onOpen={noop} onSave={noop} onTailor={noop} onDismiss={noop} />);
    expect(screen.getByText("web check unavailable — verdict from JD signals only")).toBeInTheDocument();
  });

  it("renders no evidence line when webEvidence is absent", () => {
    render(<EvalResultCard job={anywhereJob} onOpen={noop} onSave={noop} onTailor={noop} onDismiss={noop} />);
    expect(screen.queryByText(/web check unavailable/)).not.toBeInTheDocument();
  });

  it("fires onDismiss and onTailor", () => {
    const calls: string[] = [];
    render(
      <EvalResultCard
        job={anywhereJob}
        onOpen={noop}
        onSave={noop}
        onTailor={() => calls.push("tailor")}
        onDismiss={() => calls.push("dismiss")}
      />,
    );
    fireEvent.click(screen.getByLabelText("Dismiss"));
    fireEvent.click(screen.getByText("Tailor résumé"));
    expect(calls).toEqual(["dismiss", "tailor"]);
  });

  it("renders the alreadyKnown note naming the job's actual scope", () => {
    render(
      <EvalResultCard job={anywhereJob} onOpen={noop} onSave={noop} onTailor={noop} onDismiss={noop} alreadyKnownScopeLabel="Remote" />,
    );
    expect(screen.getByText("Already tracked in your Remote feed.")).toBeInTheDocument();
  });
});
