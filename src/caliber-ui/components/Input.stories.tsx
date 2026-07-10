import type { Meta, StoryObj } from "@storybook/react";
import { Input } from "./Input";

const meta: Meta<typeof Input> = {
  title: "Primitives/Input",
  component: Input,
};
export default meta;
type Story = StoryObj<typeof Input>;

export const Default: Story = {
  args: { label: "Job title", placeholder: "e.g. Senior Product Designer" },
};

export const WithValue: Story = {
  args: { label: "Company", defaultValue: "Linear" },
};

export const NoLabel: Story = {
  args: { placeholder: "Search jobs..." },
};

export const Group: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, width: 280 }}>
      <Input label="Job title" placeholder="e.g. Staff Engineer" />
      <Input label="Location" defaultValue="Remote — US" />
      <Input label="Salary expectation" type="number" placeholder="180000" />
    </div>
  ),
};
