import type { Meta, StoryObj } from "@storybook/react";
import { NotificationBell } from "./NotificationBell";

const meta: Meta<typeof NotificationBell> = {
  title: "Compositions/Shell/NotificationBell",
  component: NotificationBell,
};
export default meta;
type Story = StoryObj<typeof NotificationBell>;

export const Zero: Story = {
  args: { count: 0 },
};

export const WithAlerts: Story = {
  args: { count: 3 },
};

export const ManyAlerts: Story = {
  args: { count: 128 },
};
