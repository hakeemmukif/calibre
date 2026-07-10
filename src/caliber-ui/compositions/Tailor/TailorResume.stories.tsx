import type { Meta, StoryObj } from "@storybook/react";
import { TailorResume } from "./TailorResume";
import { jobs, resume, tailored } from "../../fixtures";

const meta: Meta<typeof TailorResume> = {
  title: "Compositions/Tailor/TailorResume",
  component: TailorResume,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof TailorResume>;

const job = jobs.find((j) => j.id === tailored.jobId)!;
const onGenerate = () => console.log("generate");
const onExport = () => console.log("export");
const onSave = (t: unknown) => console.log("save", t);

export const Configuring: Story = {
  args: { job, resume, onGenerate, onExport, onSave, status: "configuring" },
};

export const Generating: Story = {
  args: { job, resume, onGenerate, onExport, onSave, status: "generating" },
};

export const Review: Story = {
  args: { job, resume, tailored, onGenerate, onExport, onSave, status: "review" },
};

export const AllRejected: Story = {
  args: {
    job,
    resume,
    tailored,
    onGenerate,
    onExport,
    onSave,
    status: "review",
    initialAccepted: tailored.diff.map(() => false),
  },
};

export const GenerationError: Story = {
  args: { job, resume, onGenerate, onExport, onSave, status: "error", error: "Tailoring failed — the model timed out. Try again." },
};

export const Saved: Story = {
  args: { job, resume, tailored, onGenerate, onExport, onSave, status: "saved" },
};

export const Exporting: Story = {
  args: { job, resume, tailored, onGenerate, onExport, onSave, status: "exporting" },
};
