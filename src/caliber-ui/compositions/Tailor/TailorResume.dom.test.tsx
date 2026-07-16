// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { TailorResume } from "./TailorResume";
import { jobs, resume, tailored, correlationReport } from "../../fixtures";

// vitest.config.ts runs without `test.globals`, so @testing-library/react's
// automatic afterEach(cleanup) never registers — clean up explicitly.
afterEach(cleanup);

const job = jobs.find((j) => j.id === tailored.jobId)!;

const base = {
  job,
  resume,
  accepted: [],
  onToggle: () => {},
  onAnalyze: () => {},
  onRewrite: () => {},
  onSave: () => {},
  onExport: () => {},
};

describe("TailorResume (F6 phase 2)", () => {
  it("renders the report and fires onRewrite", () => {
    const onRewrite = vi.fn();
    render(<TailorResume {...base} status="report" report={correlationReport} onRewrite={onRewrite} />);
    fireEvent.click(screen.getByRole("button", { name: /rewrite to close these/i }));
    expect(onRewrite).toHaveBeenCalled();
  });

  it("shows the ATS delta in the saved state", () => {
    const saved = { ...tailored, atsDelta: { before: 3, after: 6, total: 7 } };
    render(<TailorResume {...base} status="saved" tailored={saved} />);
    expect(screen.getByText(/3 → 6/)).toBeInTheDocument();
  });

  it("shows the needs-score CTA on the needs-score state", () => {
    render(<TailorResume {...base} status="needs-score" needsScoreMessage="Score this job first." />);
    expect(screen.getByText(/score this job first/i)).toBeInTheDocument();
  });
});
