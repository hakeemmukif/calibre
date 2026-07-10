import type { Meta, StoryObj } from "@storybook/react";
import { FitBar } from "./FitBar";

const meta: Meta<typeof FitBar> = {
  title: "Primitives/FitBar",
  component: FitBar,
};
export default meta;
type Story = StoryObj<typeof FitBar>;

export const Default: Story = {
  args: { label: "Overall fit", value: 82 },
};

export const Tones: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, width: 320 }}>
      <FitBar label="Skills match" value={88} tone="good" />
      <FitBar label="Experience level" value={58} tone="warn" />
      <FitBar label="Location fit" value={22} tone="weak" />
      <FitBar label="Overall fit (gradient)" value={74} />
    </div>
  ),
};

export const CustomDisplay: Story = {
  args: { label: "Skills matched", value: 75, display: "9 / 12", tone: "good" },
};
