import type { Meta, StoryObj } from "@storybook/react";
import { ScanProgress, type ScanProgressStageRow } from "./ScanProgress";

const meta: Meta<typeof ScanProgress> = {
  title: "Compositions/Feed/ScanProgress",
  component: ScanProgress,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof ScanProgress>;

// must mirror features/search/scanStages.ts SCAN_STAGES
const runningStages: ScanProgressStageRow[] = [
  { stage: "sources", label: "Discovering postings", state: "done" },
  { stage: "fetch", label: "Reading each posting", state: "done" },
  { stage: "score", label: "Scoring fit", state: "active", current: 4, total: 30, detail: "4/30 scored" },
  { stage: "legitimacy", label: "Filtering ghost jobs", state: "pending" },
];

const doneStages: ScanProgressStageRow[] = runningStages.map((s) => ({ ...s, state: "done", detail: undefined }));

export const Running: Story = {
  args: { status: "running", stages: runningStages, onClose: () => console.log("continue in background") },
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
