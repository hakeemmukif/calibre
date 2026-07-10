import type { Meta, StoryObj } from "@storybook/react";
import { QuestionIntake } from "./QuestionIntake";
import { questions } from "../../fixtures";

const meta: Meta<typeof QuestionIntake> = {
  title: "Compositions/Apply/QuestionIntake",
  component: QuestionIntake,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof QuestionIntake>;

const noop = () => console.log("action");
const noopExtract = () => console.log("extract");

export const Detected: Story = {
  args: { mode: "detected", detected: questions, onModeChange: noop, onExtract: noopExtract, onManualAdd: noop },
};

export const DetectedEmpty: Story = {
  args: { mode: "detected", detected: [], onModeChange: noop, onExtract: noopExtract, onManualAdd: noop },
};

export const PasteFormIdle: Story = {
  args: { mode: "paste-form", onModeChange: noop, onExtract: noopExtract, onManualAdd: noop },
};

export const PasteJDIdle: Story = {
  args: { mode: "paste-jd", onModeChange: noop, onExtract: noopExtract, onManualAdd: noop },
};

export const Extracting: Story = {
  args: { mode: "paste-jd", extracting: true, onModeChange: noop, onExtract: noopExtract, onManualAdd: noop },
};

export const ExtractFailed: Story = {
  args: {
    mode: "paste-form",
    error: "Couldn't find any questions in that text — try Paste JD, or add them manually.",
    onModeChange: noop,
    onExtract: noopExtract,
    onManualAdd: noop,
  },
};
