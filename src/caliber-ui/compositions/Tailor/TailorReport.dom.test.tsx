// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { TailorReport } from "./TailorReport";
import { correlationReport } from "../../fixtures";

// vitest.config.ts runs without `test.globals`, so @testing-library/react's
// automatic afterEach(cleanup) never registers — clean up explicitly.
afterEach(cleanup);

const noop = () => {};

describe("TailorReport (spec §5)", () => {
  it("shows both signals as separate readouts with no fused percentage", () => {
    render(<TailorReport report={correlationReport} rewriting={false} onRewrite={noop} />);
    expect(screen.getByText(/Requirements covered/i)).toBeInTheDocument();
    expect(screen.getByText(/ATS keywords/i)).toBeInTheDocument();
    // met+buried = 5 of 7
    expect(screen.getByText(/5 of 7/)).toBeInTheDocument();
    // ats present = 3 of 7
    expect(screen.getByText("3 of 7")).toBeInTheDocument();
  });

  it("orders groups Buried → Met → Gap", () => {
    render(<TailorReport report={correlationReport} rewriting={false} onRewrite={noop} />);
    const headings = screen.getAllByText(/Buried|Met|Gap/).map((n) => n.textContent);
    const buried = headings.findIndex((t) => /Buried/.test(t!));
    const met = headings.findIndex((t) => /Met/.test(t!));
    const gap = headings.findIndex((t) => /Gap/.test(t!));
    expect(buried).toBeLessThan(met);
    expect(met).toBeLessThan(gap);
  });

  it("renders a verbatim evidence quote for a buried row", () => {
    render(<TailorReport report={correlationReport} rewriting={false} onRewrite={noop} />);
    expect(screen.getByText(/deployed containerized microservices/)).toBeInTheDocument();
  });

  it("lists the missing ATS terms", () => {
    render(<TailorReport report={correlationReport} rewriting={false} onRewrite={noop} />);
    expect(screen.getByText("kubernetes")).toBeInTheDocument();
  });

  it("fires onRewrite when the CTA is clicked", () => {
    const onRewrite = vi.fn();
    render(<TailorReport report={correlationReport} rewriting={false} onRewrite={onRewrite} />);
    fireEvent.click(screen.getByRole("button", { name: /rewrite to close these/i }));
    expect(onRewrite).toHaveBeenCalledOnce();
  });

  it("disables the rewrite CTA when there are no candidates (all rows are gap)", () => {
    const onRewrite = vi.fn();
    const allGapReport = {
      ...correlationReport,
      semantic: { ...correlationReport.semantic, met: 0, buried: 0, gap: correlationReport.semantic.total },
      rows: correlationReport.rows.map((r) => ({ ...r, status: "gap" as const, evidence: null })),
    };
    render(<TailorReport report={allGapReport} rewriting={false} onRewrite={onRewrite} />);
    const button = screen.getByRole("button", { name: /rewrite to close these/i });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onRewrite).not.toHaveBeenCalled();
  });
});
