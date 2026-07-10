import type { Meta, StoryObj } from "@storybook/react";
import { Textarea } from "./Textarea";

const meta: Meta<typeof Textarea> = {
  title: "Primitives/Textarea",
  component: Textarea,
};
export default meta;
type Story = StoryObj<typeof Textarea>;

export const Default: Story = {
  args: { label: "Cover note", placeholder: "Paste or write here…" },
};

export const WithValue: Story = {
  args: { label: "Summary", defaultValue: "Backend engineer with 6 years building payments systems." },
};

export const NoLabel: Story = {
  args: { placeholder: "Paste the job description…", rows: 6 },
};
