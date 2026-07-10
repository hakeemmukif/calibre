import type { Meta, StoryObj } from "@storybook/react";
import { Tag, type TagTone } from "./Tag";

const meta: Meta<typeof Tag> = {
  title: "Primitives/Tag",
  component: Tag,
};
export default meta;
type Story = StoryObj<typeof Tag>;

const tones: { tone: TagTone; label: string }[] = [
  { tone: "good", label: "Strong match" },
  { tone: "verified", label: "Verified employer" },
  { tone: "warn", label: "Missing skill" },
  { tone: "ghost", label: "Not applied" },
  { tone: "danger", label: "Rejected" },
  { tone: "neutral", label: "Draft" },
];

export const Default: Story = {
  args: { tone: "good", children: "Strong match" },
};

export const AllTones: Story = {
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
      {tones.map(({ tone, label }) => (
        <Tag key={tone} tone={tone}>{label}</Tag>
      ))}
    </div>
  ),
};
