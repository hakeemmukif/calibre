import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { FilterChips, type FeedFilter } from "./FilterChips";

const meta: Meta<typeof FilterChips> = {
  title: "Compositions/Feed/FilterChips",
  component: FilterChips,
};
export default meta;
type Story = StoryObj<typeof FilterChips>;

const fullCounts: Record<FeedFilter, number> = { all: 6, new: 2, verified: 2, suspicious: 1, remote: 3, fit4: 3 };
const emptyCounts: Record<FeedFilter, number> = { all: 6, new: 0, verified: 2, suspicious: 0, remote: 3, fit4: 3 };

function Controlled({ counts }: { counts: Record<FeedFilter, number> }) {
  const [active, setActive] = React.useState<FeedFilter>("all");
  return <FilterChips active={active} counts={counts} onChange={setActive} />;
}

export const AllActive: Story = {
  render: () => <Controlled counts={fullCounts} />,
};

export const WithEmptyCounts: Story = {
  render: () => <Controlled counts={emptyCounts} />,
};
