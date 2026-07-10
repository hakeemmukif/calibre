import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { AnswerCard } from "./AnswerCard";
import { resume, questions, answers } from "../../fixtures";
import { ApplicationQuestion } from "../../../types";

const meta: Meta<typeof AnswerCard> = {
  title: "Compositions/Apply/AnswerCard",
  component: AnswerCard,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof AnswerCard>;

const noop = () => console.log("action");

function decorate(children: React.ReactNode) {
  return <div style={{ maxWidth: 560 }}>{children}</div>;
}

export const Drafting: Story = {
  render: () =>
    decorate(
      <AnswerCard
        question={questions[0]}
        answer={{ ...answers.answers[0], answer: "" }}
        resume={resume}
        status="drafting"
        onChangeText={noop}
        onRegenerate={noop}
        onCopy={noop}
        onSelectGrounding={noop}
      />,
    ),
};

export const ReadyMultiCitation: Story = {
  render: () =>
    decorate(
      <AnswerCard
        question={questions[1]}
        answer={answers.answers[1]}
        resume={resume}
        status="ready"
        onChangeText={noop}
        onRegenerate={noop}
        onCopy={noop}
        onSelectGrounding={noop}
      />,
    ),
};

export const InferredFromJD: Story = {
  render: () =>
    decorate(
      <AnswerCard
        question={questions[0]}
        answer={answers.answers[0]}
        resume={resume}
        status="ready"
        source="jd-inferred"
        onChangeText={noop}
        onRegenerate={noop}
        onCopy={noop}
        onSelectGrounding={noop}
      />,
    ),
};

export const EditedDirty: Story = {
  render: () =>
    decorate(
      <AnswerCard
        question={questions[1]}
        answer={{ ...answers.answers[1], answer: answers.answers[1].answer + " (hand-edited detail)" }}
        resume={resume}
        status="edited"
        onChangeText={noop}
        onRegenerate={noop}
        onCopy={noop}
        onSelectGrounding={noop}
      />,
    ),
};

export const Ungrounded: Story = {
  render: () =>
    decorate(
      <AnswerCard
        question={questions[2]}
        answer={answers.answers[2]}
        resume={resume}
        status="ready"
        onChangeText={noop}
        onRegenerate={noop}
        onCopy={noop}
        onSelectGrounding={noop}
      />,
    ),
};

export const PerCardError: Story = {
  render: () =>
    decorate(
      <AnswerCard
        question={questions[0]}
        answer={{ ...answers.answers[0], answer: "" }}
        resume={resume}
        status="error"
        onChangeText={noop}
        onRegenerate={noop}
        onCopy={noop}
        onSelectGrounding={noop}
        onRetry={noop}
      />,
    ),
};

const selectQuestion = ApplicationQuestion.parse({
  id: "q-select",
  prompt: "How did you hear about this role?",
  kind: "select",
  options: ["LinkedIn", "Referral", "Job board", "Company site"],
  required: true,
});

export const SelectKind: Story = {
  render: () =>
    decorate(
      <AnswerCard
        question={selectQuestion}
        answer={{ questionId: "q-select", prompt: selectQuestion.prompt, answer: "Referral", grounding: [] }}
        resume={resume}
        status="ready"
        onChangeText={noop}
        onRegenerate={noop}
        onCopy={noop}
        onSelectGrounding={noop}
      />,
    ),
};

export const BooleanKind: Story = {
  render: () =>
    decorate(
      <AnswerCard
        question={questions[2]}
        answer={answers.answers[2]}
        resume={resume}
        status="ready"
        onChangeText={noop}
        onRegenerate={noop}
        onCopy={noop}
        onSelectGrounding={noop}
      />,
    ),
};
