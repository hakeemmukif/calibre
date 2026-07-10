import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { ResumeRail } from "./ResumeRail";
import { resume, answers } from "../../fixtures";

const meta: Meta<typeof ResumeRail> = {
  title: "Compositions/Apply/ResumeRail",
  component: ResumeRail,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof ResumeRail>;

function Stateful(props: { initialOpen: boolean; active?: (typeof answers.answers)[number]["grounding"][number] }) {
  const [open, setOpen] = React.useState(props.initialOpen);
  return <ResumeRail resume={resume} open={open} onToggle={() => setOpen((o) => !o)} active={props.active} />;
}

export const Collapsed: Story = {
  render: () => <Stateful initialOpen={false} />,
};

export const Open: Story = {
  render: () => <Stateful initialOpen />,
};

export const ScrolledToSource: Story = {
  render: () => <Stateful initialOpen active={answers.answers[1].grounding[0]} />,
};
