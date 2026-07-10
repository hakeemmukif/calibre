import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { Tabs, type TabItem } from "./Tabs";

const meta: Meta<typeof Tabs> = {
  title: "Primitives/Tabs",
  component: Tabs,
};
export default meta;
type Story = StoryObj<typeof Tabs>;

const tabs: TabItem[] = [
  { id: "overview", label: "Overview" },
  { id: "requirements", label: "Requirements" },
  { id: "applicants", label: "Applicants" },
  { id: "notes", label: "Notes" },
];

export const Default: Story = {
  args: { tabs, activeId: "overview" },
};

export const Interactive: Story = {
  render: () => {
    const [activeId, setActiveId] = React.useState("overview");
    return <Tabs tabs={tabs} activeId={activeId} onSelect={setActiveId} />;
  },
};
