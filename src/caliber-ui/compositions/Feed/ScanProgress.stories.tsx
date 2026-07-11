import type { Meta, StoryObj } from "@storybook/react";
import { ScanProgress, type ScanProgressStageRow } from "./ScanProgress";

const meta: Meta<typeof ScanProgress> = {
  title: "Compositions/Feed/ScanProgress",
  component: ScanProgress,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof ScanProgress>;

const runningStages: ScanProgressStageRow[] = [
  { stage: "discover", label: "Finding jobs across boards", state: "done" },
  { stage: "extract", label: "Reading job descriptions", state: "done" },
  { stage: "score", label: "Scoring fit and legitimacy", state: "active", current: 4, total: 30, detail: "4/30 scored" },
  { stage: "finalize", label: "Finalizing your feed", state: "pending" },
];

const doneStages: ScanProgressStageRow[] = runningStages.map((s) => ({ ...s, state: "done", detail: undefined }));

export const Running: Story = {
  args: { status: "running", stages: runningStages },
};

export const Done: Story = {
  args: {
    status: "done",
    stages: doneStages,
    stats: { scanned: 112, worth: 9, ghosts: 13 },
    onClose: () => console.log("view matches"),
  },
};

export const Error: Story = {
  args: {
    status: "error",
    stages: runningStages,
    error: "Couldn't reach the scan service. Check your connection and try again.",
    onClose: () => console.log("dismiss"),
  },
};
