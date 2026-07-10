import type { Meta, StoryObj } from "@storybook/react";
import { Chip } from "./Chip";

const meta: Meta<typeof Chip> = {
  title: "Primitives/Chip",
  component: Chip,
};
export default meta;
type Story = StoryObj<typeof Chip>;

export const Default: Story = {
  args: { children: "Remote" },
};

export const FilterSelected: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 8 }}>
      <Chip variant="filter">All jobs</Chip>
      <Chip variant="filter" selected>Applied</Chip>
      <Chip variant="filter">Interviewing</Chip>
      <Chip variant="filter">Offers</Chip>
    </div>
  ),
};

export const DefaultSelected: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 8 }}>
      <Chip>React</Chip>
      <Chip selected>TypeScript</Chip>
      <Chip>Node.js</Chip>
      <Chip selected>GraphQL</Chip>
    </div>
  ),
};

export const Dashed: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 8 }}>
      <Chip dashed iconLeft="plus">Add skill</Chip>
    </div>
  ),
};

export const AllStates: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <Chip variant="default">Default</Chip>
        <Chip variant="default" selected>Selected</Chip>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Chip variant="filter">Filter</Chip>
        <Chip variant="filter" selected>Filter selected</Chip>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Chip dashed iconLeft="plus">Dashed</Chip>
      </div>
    </div>
  ),
};
