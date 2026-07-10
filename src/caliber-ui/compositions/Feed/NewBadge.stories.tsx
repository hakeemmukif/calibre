import type { Meta, StoryObj } from "@storybook/react";
import { NewBadge } from "./NewBadge";

const meta: Meta<typeof NewBadge> = {
  title: "Compositions/Feed/NewBadge",
  component: NewBadge,
};
export default meta;
type Story = StoryObj<typeof NewBadge>;

export const Default: Story = {
  args: { label: "New" },
};

export const CustomLabel: Story = {
  args: { label: "New · 2h" },
};
