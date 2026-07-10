import type { Meta, StoryObj } from "@storybook/react";
import { JobFeed } from "./JobFeed";
import { jobs } from "../../fixtures";

const meta: Meta<typeof JobFeed> = {
  title: "Compositions/Feed/JobFeed",
  component: JobFeed,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof JobFeed>;

const onRowAction = (id: string, action: string) => console.log(id, action);

export const Loading: Story = {
  args: { jobs: [], filter: "all", loading: true, onRowAction },
};

export const Empty: Story = {
  args: { jobs: [], filter: "all", loading: false, onRowAction },
};

export const EmptyAfterFilter: Story = {
  args: { jobs: jobs.filter((j) => j.legitimacy.tier === "verified" && !j.isNew), filter: "new", loading: false, onRowAction },
};

export const ErrorWithRetry: Story = {
  args: {
    jobs: [],
    filter: "all",
    loading: false,
    error: "Couldn't reach the scan service. Check your connection and try again.",
    onRetry: () => console.log("retry"),
    onRowAction,
  },
};

export const Populated: Story = {
  args: { jobs, filter: "all", loading: false, onRowAction },
};

export const AllFlagged: Story = {
  args: { jobs: jobs.filter((j) => j.legitimacy.tier !== "verified" && j.legitimacy.tier !== "clear"), filter: "all", loading: false, onRowAction },
};
