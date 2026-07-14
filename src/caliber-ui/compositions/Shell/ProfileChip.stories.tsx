import type { Meta, StoryObj } from "@storybook/react";
import { ProfileChip } from "./ProfileChip";

const meta: Meta<typeof ProfileChip> = {
  title: "Compositions/Shell/ProfileChip",
  component: ProfileChip,
};
export default meta;
type Story = StoryObj<typeof ProfileChip>;

export const User: Story = {
  args: {
    user: { id: "u1", email: "alex@caliber.dev", role: "user" },
    onLogout: () => console.log("logout"),
  },
};

export const Admin: Story = {
  args: {
    user: { id: "u2", email: "root@caliber.dev", role: "admin" },
    onLogout: () => console.log("logout"),
  },
};

export const NoLogoutAffordance: Story = {
  args: {
    user: { id: "u1", email: "alex@caliber.dev", role: "user" },
  },
};
