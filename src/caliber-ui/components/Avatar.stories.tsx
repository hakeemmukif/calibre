import type { Meta, StoryObj } from "@storybook/react";
import { Avatar, type AvatarSize } from "./Avatar";

const meta: Meta<typeof Avatar> = {
  title: "Primitives/Avatar",
  component: Avatar,
};
export default meta;
type Story = StoryObj<typeof Avatar>;

const sizes: AvatarSize[] = ["sm", "md", "lg"];

export const Default: Story = {
  args: { name: "Amara Chen" },
};

export const Sizes: Story = {
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      {sizes.map((size) => (
        <Avatar key={size} name="Amara Chen" size={size} />
      ))}
    </div>
  ),
};

export const SquareForCompanies: Story = {
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      {sizes.map((size) => (
        <Avatar key={size} name="Linear" size={size} square />
      ))}
    </div>
  ),
};

export const NoName: Story = {
  args: {},
};
