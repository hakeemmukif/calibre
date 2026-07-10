import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { TrackerTable, type SortSpec } from "./TrackerTable";
import { applications } from "../../fixtures";

const meta: Meta<typeof TrackerTable> = {
  title: "Compositions/Tracker/TrackerTable",
  component: TrackerTable,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof TrackerTable>;

const onOpen = (id: string) => console.log("open", id);
const onLogUpdate = (id: string) => console.log("log-update", id);

export const Empty: Story = {
  args: {
    rows: [],
    sort: { key: "appliedAt", dir: "desc" },
    onSort: (spec) => console.log("sort", spec),
    onOpen,
    onLogUpdate,
    onGoToFeed: () => console.log("go to feed"),
  },
};

// Populated / SortedByFit — a real controlled wrapper so the column-header
// sort toggles actually re-order rows in Canvas, since TrackerTable no
// longer owns `sort` internally.
function SortableDemo({ initial }: { initial: SortSpec }) {
  const [sort, setSort] = React.useState<SortSpec>(initial);
  return <TrackerTable rows={applications} sort={sort} onSort={setSort} onOpen={onOpen} onLogUpdate={onLogUpdate} />;
}

export const Populated: Story = {
  render: () => <SortableDemo initial={{ key: "appliedAt", dir: "desc" }} />,
};

export const SortedByFit: Story = {
  render: () => <SortableDemo initial={{ key: "score", dir: "asc" }} />,
};

export const ClosedOnly: Story = {
  args: {
    rows: applications.filter((a) => a.statusTone === "neutral"),
    sort: { key: "appliedAt", dir: "desc" },
    onSort: (spec) => console.log("sort", spec),
    onOpen,
    onLogUpdate,
    initialTab: "closed",
  },
};

export const TailoredFlagRow: Story = {
  args: {
    rows: applications.filter((a) => a.tailored),
    sort: { key: "appliedAt", dir: "desc" },
    onSort: (spec) => console.log("sort", spec),
    onOpen,
    onLogUpdate,
  },
};
