import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { AppSidebar } from "./AppSidebar";

const meta: Meta<typeof AppSidebar> = {
  title: "Compositions/Shell/AppSidebar",
  component: AppSidebar,
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<typeof AppSidebar>;

function Demo(props: React.ComponentProps<typeof AppSidebar>) {
  const [activeId, setActiveId] = React.useState(props.activeId ?? "matches");
  return (
    <div style={{ height: 640, display: "flex" }}>
      <AppSidebar {...props} activeId={activeId} onSelect={setActiveId} />
    </div>
  );
}

// A normal user: no Admin section.
export const NormalUser: Story = {
  render: () => <Demo user={{ id: "u1", email: "alex@caliber.dev", role: "user" }} onLogout={() => console.log("logout")} />,
};

// An admin user: the Admin section + "Users" row appear at the bottom of the nav.
export const AdminUser: Story = {
  render: () => (
    <Demo
      user={{ id: "u2", email: "root@caliber.dev", role: "admin" }}
      activeId="admin-users"
      onLogout={() => console.log("logout")}
    />
  ),
};

// No session yet — sidebar renders with an empty footer, no fake user.
export const NoUser: Story = {
  render: () => <Demo />,
};
