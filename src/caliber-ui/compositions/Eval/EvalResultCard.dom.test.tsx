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
