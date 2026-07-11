import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { SourceList } from "./SourceList";
import { sources } from "../../fixtures";
import type { Source } from "../../../types";

const meta: Meta<typeof SourceList> = {
  title: "Compositions/Sources/SourceList",
  component: SourceList,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof SourceList>;

const onToggleLog = (id: string, enabled: boolean) => console.log(id, enabled);

// Populated — a real controlled wrapper so the toggle is clickable in Canvas.
function PopulatedDemo() {
  const [rows, setRows] = React.useState<Source[]>(sources);
  return (
    <SourceList
      sources={rows}
      onToggle={(id, enabled) => setRows((prev) => prev.map((s) => (s.id === id ? { ...s, enabled } : s)))}
    />
  );
}

export const Populated: Story = {
  render: () => <PopulatedDemo />,
};

export const SomeDisabled: Story = {
  args: {
    sources: sources.map((s) => (s.id === "ashby-ramp" || s.id === "lever-toptal" ? { ...s, enabled: false } : s)),
    onToggle: onToggleLog,
  },
};

export const Busy: Story = {
  args: {
    sources,
    busyId: "gh-stripe",
    onToggle: onToggleLog,
  },
};
