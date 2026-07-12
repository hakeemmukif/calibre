import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { UrlEvalBar, type UrlEvalStatus } from "./UrlEvalBar";

const meta: Meta<typeof UrlEvalBar> = {
  title: "Compositions/Shell/UrlEvalBar",
  component: UrlEvalBar,
};
export default meta;
type Story = StoryObj<typeof UrlEvalBar>;

function Demo(props: {
  status: UrlEvalStatus;
  stageText?: string;
  error?: string;
  showPasteBox?: boolean;
}) {
  return (
    <UrlEvalBar
      {...props}
      onSubmit={(url, text) => console.log("eval", url, text)}
    />
  );
}

export const Idle: Story = {
  render: () => <Demo status="idle" />,
};

export const Evaluating: Story = {
  render: () => <Demo status="evaluating" />,
};

export const EvaluatingWithStage: Story = {
  render: () => <Demo status="evaluating" stageText="Reading the posting…" />,
};

export const Success: Story = {
  render: () => <Demo status="success" />,
};

export const InvalidUrlError: Story = {
  render: () => <Demo status="error" error="That doesn't look like a job posting URL." />,
};

export const NeedsTextPasteBox: Story = {
  render: () => (
    <Demo
      status="error"
      error="We couldn't read that page automatically — paste the posting text below and try again."
      showPasteBox
    />
  ),
};
