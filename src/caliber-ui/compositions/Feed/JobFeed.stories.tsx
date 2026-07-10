import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { JobFeed } from "./JobFeed";
import type { FeedFilter } from "./FilterChips";
import type { SummaryStripStats } from "../../../types";
import { jobs } from "../../fixtures";

const meta: Meta<typeof JobFeed> = {
  title: "Compositions/Feed/JobFeed",
  component: JobFeed,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof JobFeed>;

const onRowAction = (id: string, action: string) => console.log(id, action);
const onFilterChangeLog = (f: FeedFilter) => console.log("filter", f);

const zeroStats: SummaryStripStats = { scanned: 0, worth: 0, ghosts: 0, flagged: 0, sinceLast: 0 };
const populatedStats: SummaryStripStats = { scanned: jobs.length, worth: 4, ghosts: 1, flagged: 2, sinceLast: 2 };

export const Loading: Story = {
  args: { jobs: [], filter: "all", onFilterChange: onFilterChangeLog, stats: zeroStats, loading: true, onRowAction },
};

export const Empty: Story = {
  args: { jobs: [], filter: "all", onFilterChange: onFilterChangeLog, stats: zeroStats, loading: false, onRowAction },
};

export const EmptyAfterFilter: Story = {
  args: {
    jobs: jobs.filter((j) => j.legitimacy.tier === "verified" && !j.isNew),
    filter: "new",
    onFilterChange: onFilterChangeLog,
    stats: populatedStats,
    loading: false,
    onRowAction,
  },
};

export const ErrorWithRetry: Story = {
  args: {
    jobs: [],
    filter: "all",
    onFilterChange: onFilterChangeLog,
    stats: zeroStats,
    loading: false,
    error: "Couldn't reach the scan service. Check your connection and try again.",
    onRetry: () => console.log("retry"),
    onRowAction,
  },
};

// Populated — a real controlled wrapper so the filter chips are clickable in
// Canvas, since JobFeed no longer owns `activeFilter` internally.
function PopulatedDemo() {
  const [filter, setFilter] = React.useState<FeedFilter>("all");
  return <JobFeed jobs={jobs} filter={filter} onFilterChange={setFilter} stats={populatedStats} loading={false} onRowAction={onRowAction} />;
}

export const Populated: Story = {
  render: () => <PopulatedDemo />,
};

export const AllFlagged: Story = {
  args: {
    jobs: jobs.filter((j) => j.legitimacy.tier !== "verified" && j.legitimacy.tier !== "clear"),
    filter: "all",
    onFilterChange: onFilterChangeLog,
    stats: populatedStats,
    loading: false,
    onRowAction,
  },
};
