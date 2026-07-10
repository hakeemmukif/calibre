import type { Meta, StoryObj } from "@storybook/react";
import { Select } from "./Select";

const meta: Meta<typeof Select> = {
  title: "Primitives/Select",
  component: Select,
};
export default meta;
type Story = StoryObj<typeof Select>;

export const Default: Story = {
  args: {
    label: "Application status",
    options: ["Applied", "Interviewing", "Offer", "Rejected"],
  },
};

export const WithValueLabels: Story = {
  args: {
    label: "Experience level",
    options: [
      { value: "junior", label: "Junior (0-2 yrs)" },
      { value: "mid", label: "Mid (3-5 yrs)" },
      { value: "senior", label: "Senior (6+ yrs)" },
    ],
    defaultValue: "mid",
  },
};

export const Group: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, width: 280 }}>
      <Select label="Status" options={["Applied", "Interviewing", "Offer", "Rejected"]} />
      <Select label="Sort by" options={["Fit score", "Date applied", "Company"]} />
    </div>
  ),
};
