import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { SidebarNav, type NavItem } from "./SidebarNav";

const meta: Meta<typeof SidebarNav> = {
  title: "Primitives/SidebarNav",
  component: SidebarNav,
};
export default meta;
type Story = StoryObj<typeof SidebarNav>;

const items: NavItem[] = [
  { section: "Pipeline" },
  { id: "dashboard", label: "Dashboard", icon: "layers" },
  { id: "jobs", label: "Job matches", icon: "target", count: 24 },
  { id: "applications", label: "Applications", icon: "send", count: 8 },
  { id: "interviews", label: "Interviews", icon: "calendar", count: 2 },
  { section: "Tools" },
  { id: "resume", label: "Resume tailor", icon: "sparkles" },
  { id: "companies", label: "Companies", icon: "building" },
  { id: "contacts", label: "Contacts", icon: "users" },
];

export const Default: Story = {
  render: () => (
    <div style={{ height: 520, display: "flex" }}>
      <SidebarNav brand="Caliber" items={items} activeId="jobs" />
    </div>
  ),
};

export const Interactive: Story = {
  render: () => {
    const [activeId, setActiveId] = React.useState("jobs");
    return (
      <div style={{ height: 520, display: "flex" }}>
        <SidebarNav brand="Caliber" items={items} activeId={activeId} onSelect={setActiveId} />
      </div>
    );
  },
};
