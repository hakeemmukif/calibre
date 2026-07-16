import type { Meta, StoryObj } from "@storybook/react";
import { TailorResume } from "../compositions/Tailor/TailorResume";
import { jobs, resume, tailored } from "../fixtures";

const meta: Meta = {
  title: "Pages/Tailor",
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj;

// Pages/Tailor — F6 assembled on fixtures: header + TailorResume seeded with
// the `tailored` fixture, landing straight on the review state.
function TailorPage() {
  const job = jobs.find((j) => j.id === tailored.jobId)!;

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-app)" }}>
      <header style={{ padding: "16px 24px", background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <span style={{ font: "700 18px/1 var(--font-display)", color: "var(--text-strong)", letterSpacing: "-0.01em" }}>
          Caliber
        </span>
        <span style={{ font: "var(--type-body)", color: "var(--text-muted)", marginLeft: 14 }}>
          Tailor résumé · {job.role} at {job.company}
        </span>
      </header>
      <div style={{ maxWidth: "var(--content-max)", margin: "0 auto", padding: 24 }}>
        <TailorResume
          job={job}
          resume={resume}
          tailored={tailored}
          status="review"
          accepted={tailored.diff.map(() => true)}
          onToggle={(index, accept) => console.log("toggle", index, accept)}
          onAnalyze={() => console.log("analyze")}
          onRewrite={() => console.log("rewrite")}
          onExport={(acceptedIndices) => console.log("export", acceptedIndices)}
          onSave={(tailoredId, acceptedIndices) => console.log("save", tailoredId, acceptedIndices)}
        />
      </div>
    </div>
  );
}

export const Default: Story = {
  render: () => <TailorPage />,
};
