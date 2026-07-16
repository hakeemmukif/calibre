import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { TailorReport } from "./TailorReport";
import { correlationReport } from "../../fixtures";
import type { CorrelationReport } from "../../../types";

const meta: Meta<typeof TailorReport> = {
  title: "Compositions/Tailor/TailorReport",
  component: TailorReport,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof TailorReport>;

const allMet: CorrelationReport = {
  ...correlationReport,
  rows: correlationReport.rows.map((r) => (r.status === "buried" ? { ...r, status: "met" as const } : r)),
  semantic: {
    ...correlationReport.semantic,
    met: correlationReport.semantic.met + correlationReport.semantic.buried,
    buried: 0,
  },
};

const allGap: CorrelationReport = {
  ...correlationReport,
  rows: correlationReport.rows.map((r) => ({ ...r, status: "gap" as const, evidence: null })),
  semantic: { met: 0, buried: 0, gap: correlationReport.semantic.total, total: correlationReport.semantic.total },
  ats: { ...correlationReport.ats, missing: [] },
};

export const Default: Story = {
  render: () => <TailorReport report={correlationReport} rewriting={false} onRewrite={() => {}} />,
};

export const AllMet: Story = {
  render: () => <TailorReport report={allMet} rewriting={false} onRewrite={() => {}} />,
};

export const AllGap: Story = {
  render: () => <TailorReport report={allGap} rewriting={false} onRewrite={() => {}} />,
};

export const Rewriting: Story = {
  render: () => <TailorReport report={correlationReport} rewriting={true} onRewrite={() => {}} />,
};
