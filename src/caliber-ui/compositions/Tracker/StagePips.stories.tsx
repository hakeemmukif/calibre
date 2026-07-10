import type { Meta, StoryObj } from "@storybook/react";
import { StagePips } from "./StagePips";

const meta: Meta<typeof StagePips> = {
  title: "Compositions/Tracker/StagePips",
  component: StagePips,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof StagePips>;

export const Applied: Story = { args: { stage: 0 } };
export const Screen: Story = { args: { stage: 1 } };
export const Interview: Story = { args: { stage: 2 } };
export const Decision: Story = { args: { stage: 3 } };
