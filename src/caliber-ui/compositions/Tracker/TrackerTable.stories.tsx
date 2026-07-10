import type { Meta, StoryObj } from "@storybook/react";
import { TrackerTable } from "./TrackerTable";
import { applications } from "../../fixtures";

const meta: Meta<typeof TrackerTable> = {
  title: "Compositions/Tracker/TrackerTable",
  component: TrackerTable,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof TrackerTable>;

const onSort = (spec: unknown) => console.log("sort", spec);
const onOpen = (id: string) => console.log("open", id);
const onLogUpdate = (id: string) => console.log("log-update", id);

export const Empty: Story = {
  args: { rows: [], sort: { key: "appliedAt", dir: "desc" }, onSort, onOpen, onLogUpdate, onGoToFeed: () => console.log("go to feed") },
};

export const Populated: Story = {
  args: { rows: applications, sort: { key: "appliedAt", dir: "desc" }, onSort, onOpen, onLogUpdate },
};

export const SortedByFit: Story = {
  args: { rows: applications, sort: { key: "score", dir: "asc" }, onSort, onOpen, onLogUpdate },
};

export const ClosedOnly: Story = {
  args: {
    rows: applications.filter((a) => a.statusTone === "neutral"),
    sort: { key: "appliedAt", dir: "desc" },
    onSort,
    onOpen,
    onLogUpdate,
    initialTab: "closed",
  },
};

export const TailoredFlagRow: Story = {
  args: { rows: applications.filter((a) => a.tailored), sort: { key: "appliedAt", dir: "desc" }, onSort, onOpen, onLogUpdate },
};
