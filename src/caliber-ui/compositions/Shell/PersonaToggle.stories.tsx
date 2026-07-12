import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { PersonaToggle } from "./PersonaToggle";
import type { Persona } from "../../../types";

const meta: Meta<typeof PersonaToggle> = {
  title: "Compositions/Shell/PersonaToggle",
  component: PersonaToggle,
};
export default meta;
type Story = StoryObj<typeof PersonaToggle>;

function Controlled({ initial, disabled }: { initial: Persona; disabled?: boolean }) {
  const [value, setValue] = React.useState<Persona>(initial);
  return <PersonaToggle value={value} onChange={setValue} disabled={disabled} />;
}

export const Remote: Story = {
  render: () => <Controlled initial="remote" />,
};

export const Local: Story = {
  render: () => <Controlled initial="local" />,
};

export const Pasted: Story = {
  render: () => <Controlled initial="pasted" />,
};

export const Disabled: Story = {
  render: () => <Controlled initial="remote" disabled />,
};
