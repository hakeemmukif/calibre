import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { ChangeCard } from "./ChangeCard";
import { tailored } from "../../fixtures";

const meta: Meta<typeof ChangeCard> = {
  title: "Compositions/Tailor/ChangeCard",
  component: ChangeCard,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof ChangeCard>;

const [headlineChange, summaryChange] = tailored.diff;

function Interactive(props: { change: (typeof tailored.diff)[number] }) {
  const [accepted, setAccepted] = React.useState(true);
  return <ChangeCard change={props.change} accepted={accepted} onToggle={setAccepted} />;
}

export const Accepted: Story = {
  render: () => <ChangeCard change={headlineChange} accepted={true} onToggle={() => {}} />,
};

export const Rejected: Story = {
  render: () => <ChangeCard change={summaryChange} accepted={false} onToggle={() => {}} />,
};

export const Interactive_: Story = {
  name: "Interactive (toggleable)",
  render: () => <Interactive change={headlineChange} />,
};
