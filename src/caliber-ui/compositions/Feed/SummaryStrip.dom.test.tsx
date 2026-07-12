// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import { SummaryStrip } from "./SummaryStrip";

afterEach(cleanup);

describe("SummaryStrip excluded cell (spec §8)", () => {
  it("renders the eligibility-excluded count with its label", () => {
    render(
      <SummaryStrip stats={{ scanned: 214, worth: 38, ghosts: 12, flagged: 6, sinceLast: 9, excluded: 12 }} />,
    );
    expect(screen.getByText("Not eligible · hidden")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });
});
