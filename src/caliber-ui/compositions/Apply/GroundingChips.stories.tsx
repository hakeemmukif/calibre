import type { Meta, StoryObj } from "@storybook/react";
import { GroundingChips } from "./GroundingChips";
import { resume, answers } from "../../fixtures";

const meta: Meta<typeof GroundingChips> = {
  title: "Compositions/Apply/GroundingChips",
  component: GroundingChips,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof GroundingChips>;

const noop = () => console.log("select");

export const Grounded: Story = {
  args: { grounding: answers.answers[1].grounding, resume, onSelect: noop },
};

export const SingleCitation: Story = {
  args: { grounding: answers.answers[0].grounding, resume, onSelect: noop },
};

export const Ungrounded: Story = {
  args: { grounding: answers.answers[2].grounding, resume, onSelect: noop },
};
