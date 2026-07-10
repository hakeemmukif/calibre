import type { Meta, StoryObj } from "@storybook/react";
import { JobDetail } from "../compositions/Detail/JobDetail";
import { jobs, applications } from "../fixtures";
import { MatchDetail, type Job } from "../../types";

const meta: Meta = {
  title: "Pages/JobDetail",
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj;

function toMatchDetail(job: Job) {
  return MatchDetail.parse({
    archetype: job.persona === "remote" ? "Global remote — APAC-friendly" : "Malaysia local — on-site/hybrid",
    legitimacy: job.legitimacy,
    breakdown: job.breakdown,
  });
}

// Pages/JobDetail — the full posting view assembled on fixtures, in its
// page chrome (§11.8 cool ground). onApply opens the job's real applyUrl.
function JobDetailPage({ jobId }: { jobId: string }) {
  const job = jobs.find((j) => j.id === jobId)!;
  const applied = applications.find((a) => a.jobId === jobId);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-app)", padding: 24 }}>
      <div style={{ maxWidth: "var(--content-max, 900px)", margin: "0 auto" }}>
        <JobDetail
          job={job}
          detail={toMatchDetail(job)}
          applied={applied}
          onApply={() => window.open(job.applyUrl, "_blank", "noopener")}
          onTailor={() => console.log("tailor", job.id)}
          onAnswerQuestions={() => console.log("answer questions", job.id)}
          onMarkApplied={() => Promise.resolve(console.log("mark applied", job.id))}
        />
      </div>
    </div>
  );
}

export const Default: Story = {
  render: () => <JobDetailPage jobId="job-grab-backend" />,
};

export const AlreadyApplied: Story = {
  render: () => <JobDetailPage jobId="job-petronas-data" />,
};

export const ScamTier: Story = {
  render: () => <JobDetailPage jobId="job-wfh-scam" />,
};
