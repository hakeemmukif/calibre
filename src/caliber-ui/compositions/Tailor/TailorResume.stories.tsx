import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { TailorResume, type TailorUiState } from "./TailorResume";
import { jobs, resume, tailored, correlationReport } from "../../fixtures";

const meta: Meta<typeof TailorResume> = {
  title: "Compositions/Tailor/TailorResume",
  component: TailorResume,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof TailorResume>;

const job = jobs.find((j) => j.id === tailored.jobId)!;
const acceptedAll = tailored.diff.map(() => true);
const acceptedNone = tailored.diff.map(() => false);
const savedWithDelta = { ...tailored, atsDelta: { before: 3, after: 6, total: 7 } };
const onAnalyze = () => console.log("analyze");
const onRewrite = () => console.log("rewrite");
const onToggle = (index: number, accept: boolean) => console.log("toggle", index, accept);
const onSave = (tailoredId: string, acceptedIndices: number[]) => console.log("save", tailoredId, acceptedIndices);
const onExport = (acceptedIndices: number[]) => console.log("export", acceptedIndices);

export const Configuring: Story = {
  args: { job, resume, status: "configuring", accepted: [], onToggle, onAnalyze, onRewrite, onSave, onExport },
};

export const Correlating: Story = {
  args: { job, resume, status: "correlating", accepted: [], onToggle, onAnalyze, onRewrite, onSave, onExport },
};

export const Report: Story = {
  args: {
    job,
    resume,
    status: "report",
    report: correlationReport,
    accepted: [],
    onToggle,
    onAnalyze,
    onRewrite,
    onSave,
    onExport,
  },
};

export const NeedsScore: Story = {
  args: {
    job,
    resume,
    status: "needs-score",
    needsScoreMessage: "Score this job before tailoring.",
    accepted: [],
    onToggle,
    onAnalyze,
    onRewrite,
    onSave,
    onExport,
  },
};

export const Review: Story = {
  args: { job, resume, tailored, status: "review", accepted: acceptedAll, onToggle, onAnalyze, onRewrite, onSave, onExport },
};

export const AllRejected: Story = {
  args: { job, resume, tailored, status: "review", accepted: acceptedNone, onToggle, onAnalyze, onRewrite, onSave, onExport },
};

export const GenerationError: Story = {
  args: {
    job,
    resume,
    status: "error",
    accepted: [],
    error: "Tailoring failed — the model timed out. Try again.",
    onToggle,
    onAnalyze,
    onRewrite,
    onSave,
    onExport,
  },
};

export const Saved: Story = {
  args: { job, resume, tailored: savedWithDelta, status: "saved", accepted: acceptedAll, onToggle, onAnalyze, onRewrite, onSave, onExport },
};

export const Exporting: Story = {
  args: { job, resume, tailored, status: "exporting", accepted: acceptedAll, onToggle, onAnalyze, onRewrite, onSave, onExport },
};

// Live — a real controlled wrapper: Analyze fit simulates
// `POST /api/tailor/correlate`, Rewrite simulates `POST /api/tailor`,
// toggling a ChangeCard flips its accept flag, Save/Export simulate their
// endpoints. TailorResume itself no longer fakes any of this — the
// simulation lives here, in the story.
function LiveDemo() {
  const [status, setStatus] = React.useState<TailorUiState>("configuring");
  const [result, setResult] = React.useState<typeof tailored | undefined>(undefined);
  const [accepted, setAccepted] = React.useState<boolean[]>([]);

  function handleAnalyze() {
    setStatus("correlating");
    window.setTimeout(() => setStatus("report"), 900);
  }

  function handleRewrite() {
    setStatus("rewriting");
    window.setTimeout(() => {
      setResult(tailored);
      setAccepted(tailored.diff.map(() => true));
      setStatus("review");
    }, 900);
  }

  function handleSave(tailoredId: string, acceptedIndices: number[]) {
    console.log("save", tailoredId, acceptedIndices);
    setStatus("saved");
  }

  function handleExport(acceptedIndices: number[]) {
    console.log("export", acceptedIndices);
    setStatus("exporting");
    window.setTimeout(() => setStatus("review"), 900);
  }

  return (
    <TailorResume
      job={job}
      resume={resume}
      tailored={result}
      report={correlationReport}
      status={status}
      accepted={accepted}
      onToggle={(index, accept) => setAccepted((prev) => prev.map((a, i) => (i === index ? accept : a)))}
      onAnalyze={handleAnalyze}
      onRewrite={handleRewrite}
      onSave={handleSave}
      onExport={handleExport}
    />
  );
}

export const Live: Story = {
  render: () => <LiveDemo />,
};
