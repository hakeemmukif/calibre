import type { Meta, StoryObj } from "@storybook/react";
import { SummaryStrip } from "./SummaryStrip";

const meta: Meta<typeof SummaryStrip> = {
  title: "Compositions/Feed/SummaryStrip",
  component: SummaryStrip,
};
export default meta;
type Story = StoryObj<typeof SummaryStrip>;

export const Populated: Story = {
  args: { stats: { scanned: 214, worth: 38, ghosts: 12, flagged: 6, sinceLast: 9 } },
};

export const ZeroState: Story = {
  args: { stats: { scanned: 0, worth: 0, ghosts: 0, flagged: 0, sinceLast: 0 } },
};

export const Stale: Story = {
  args: { stats: { scanned: 214, worth: 38, ghosts: 12, flagged: 6, sinceLast: 0 } },
};
