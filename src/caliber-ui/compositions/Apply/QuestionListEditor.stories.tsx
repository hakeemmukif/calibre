import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { QuestionListEditor } from "./QuestionListEditor";
import { questions } from "../../fixtures";

const meta: Meta<typeof QuestionListEditor> = {
  title: "Compositions/Apply/QuestionListEditor",
  component: QuestionListEditor,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof QuestionListEditor>;

const noop = () => console.log("action");

function decorate(children: React.ReactNode) {
  return <div style={{ maxWidth: 640 }}>{children}</div>;
}

export const Detected: Story = {
  render: () =>
    decorate(
      <QuestionListEditor
        questions={questions}
        sources={{ q1: "ats-detected", q2: "ats-detected", q3: "ats-detected" }}
        onEdit={noop}
        onDelete={noop}
        onAdd={noop}
        onDraftAll={noop}
      />,
    ),
};

export const InferredVsDetectedMix: Story = {
  render: () =>
    decorate(
      <QuestionListEditor
        questions={questions}
        sources={{ q1: "pasted-form", q2: "jd-inferred", q3: "jd-inferred" }}
        onEdit={noop}
        onDelete={noop}
        onAdd={noop}
        onDraftAll={noop}
      />,
    ),
};

export const Drafting: Story = {
  render: () =>
    decorate(
      <QuestionListEditor
        questions={questions}
        sources={{ q1: "ats-detected", q2: "ats-detected", q3: "ats-detected" }}
        drafting
        onEdit={noop}
        onDelete={noop}
        onAdd={noop}
        onDraftAll={noop}
      />,
    ),
};

export const Empty: Story = {
  render: () => decorate(<QuestionListEditor questions={[]} onEdit={noop} onDelete={noop} onAdd={noop} onDraftAll={noop} />),
};
