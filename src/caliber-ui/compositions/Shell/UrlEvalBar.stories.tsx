import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { UrlEvalBar, type UrlEvalStatus } from "./UrlEvalBar";

const meta: Meta<typeof UrlEvalBar> = {
  title: "Compositions/Shell/UrlEvalBar",
  component: UrlEvalBar,
};
export default meta;
type Story = StoryObj<typeof UrlEvalBar>;

function Demo({ status, error }: { status: UrlEvalStatus; error?: string }) {
  return <UrlEvalBar status={status} error={error} onSubmit={(url) => console.log("eval", url)} />;
}

export const Idle: Story = {
  render: () => <Demo status="idle" />,
};

export const Evaluating: Story = {
  render: () => <Demo status="evaluating" />,
};

export const InvalidUrlError: Story = {
  render: () => <Demo status="error" error="That doesn't look like a job posting URL." />,
};
