import type { Meta, StoryObj } from "@storybook/react";
import { JobDetail } from "./JobDetail";
import { Card } from "../../components/Card";
import { jobs, applications } from "../../fixtures";
import { MatchDetail, type Job } from "../../../types";

const meta: Meta<typeof JobDetail> = {
  title: "Compositions/Apply/JobDetail",
  component: JobDetail,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof JobDetail>;

const noop = () => console.log("action");
const noopAsync = () => Promise.resolve();

// MatchDetail isn't in the shared fixtures module (only jobs/resume/
// applications/questions/answers/tailored are) — derived locally here from
// each job's own legitimacy/breakdown so it stays Zod-validated without
// touching the shared fixtures file another builder may be editing.
function toMatchDetail(job: Job) {
  return MatchDetail.parse({
    archetype: job.persona === "remote" ? "Global remote — APAC-friendly" : "Malaysia local — on-site/hybrid",
    legitimacy: job.legitimacy,
    breakdown: job.breakdown,
  });
}

const grab = jobs.find((j) => j.id === "job-grab-backend")!;
const scam = jobs.find((j) => j.id === "job-wfh-scam")!;

export const Populated: Story = {
  args: {
    job: grab,
    detail: toMatchDetail(grab),
    onApply: noop,
    onTailor: noop,
    onAnswerQuestions: noop,
    onMarkApplied: noopAsync,
  },
};

export const AlreadyApplied: Story = {
  args: {
    job: grab,
    detail: toMatchDetail(grab),
    applied: applications.find((a) => a.jobId === "job-grab-backend"),
    onApply: noop,
    onTailor: noop,
    onAnswerQuestions: noop,
    onMarkApplied: noopAsync,
  },
};

export const ScamTier: Story = {
  args: {
    job: scam,
    detail: toMatchDetail(scam),
    onApply: noop,
    onTailor: noop,
    onAnswerQuestions: noop,
    onMarkApplied: noopAsync,
  },
};

export const Loading: Story = {
  render: () => (
    <Card padding="lg" style={{ maxWidth: 720 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ height: 22, width: "55%", background: "var(--surface-sunken)", borderRadius: 4 }} />
        <div style={{ height: 14, width: "35%", background: "var(--surface-sunken)", borderRadius: 4 }} />
        <div style={{ height: 14, width: "90%", background: "var(--surface-sunken)", borderRadius: 4, marginTop: 8 }} />
        <div style={{ height: 32, width: "45%", background: "var(--surface-sunken)", borderRadius: 4, marginTop: 14 }} />
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <div style={{ height: 38, width: 110, background: "var(--surface-sunken)", borderRadius: "var(--radius-sm)" }} />
          <div style={{ height: 38, width: 140, background: "var(--surface-sunken)", borderRadius: "var(--radius-sm)" }} />
        </div>
      </div>
    </Card>
  ),
};
