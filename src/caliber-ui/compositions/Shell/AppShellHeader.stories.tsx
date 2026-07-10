import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { AppShellHeader } from "./AppShellHeader";
import type { Persona } from "../../../types";
import type { UrlEvalStatus } from "./UrlEvalBar";

const meta: Meta<typeof AppShellHeader> = {
  title: "Compositions/Shell/AppShellHeader",
  component: AppShellHeader,
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<typeof AppShellHeader>;

function Demo({ evalStatus, alertCount }: { evalStatus: UrlEvalStatus; alertCount: number }) {
  const [persona, setPersona] = React.useState<Persona>("remote");
  return (
    <AppShellHeader
      persona={persona}
      onPersona={setPersona}
      evalStatus={evalStatus}
      onEval={(url) => console.log("eval", url)}
      alertCount={alertCount}
    />
  );
}

export const Default: Story = {
  render: () => <Demo evalStatus="idle" alertCount={0} />,
};

export const Evaluating: Story = {
  render: () => <Demo evalStatus="evaluating" alertCount={0} />,
};

export const WithAlerts: Story = {
  render: () => <Demo evalStatus="idle" alertCount={5} />,
};
