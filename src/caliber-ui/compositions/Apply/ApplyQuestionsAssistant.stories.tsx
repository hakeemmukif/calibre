import type { Meta, StoryObj } from "@storybook/react";
import { ApplyQuestionsAssistant } from "./ApplyQuestionsAssistant";
import { jobs, resume, questions } from "../../fixtures";

const meta: Meta<typeof ApplyQuestionsAssistant> = {
  title: "Compositions/Apply/ApplyQuestionsAssistant",
  component: ApplyQuestionsAssistant,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof ApplyQuestionsAssistant>;

const job = jobs.find((j) => j.id === "job-grab-backend")!;
const noopSave = (a: unknown) => console.log("save answers", a);

// NoIntakeIdle — no pre-extracted form for this posting: the assistant opens
// on QuestionIntake with Detected empty, ready for Paste form / Paste JD.
export const NoIntakeIdle: Story = {
  args: { job, resume, onSaveAnswers: noopSave },
};

// DetectedReview — a known-ATS form arrives pre-extracted; intake is
// skipped straight to the editable question review.
export const DetectedReview: Story = {
  args: { job, resume, detected: questions, onSaveAnswers: noopSave },
};

// Answering — click "Draft all answers" in DetectedReview to reach this;
// pinned here for docs via the same fixtures, one click away in Canvas.
export const Answering: Story = {
  args: { job, resume, detected: questions, onSaveAnswers: noopSave },
  parameters: {
    docs: { description: { story: "Click \"Draft all answers\" to watch each AnswerCard stream from drafting → ready." } },
  },
};
