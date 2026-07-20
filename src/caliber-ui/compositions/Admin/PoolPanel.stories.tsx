import type { Meta, StoryObj } from "@storybook/react";
import { PoolPanel } from "./PoolPanel";
import { adminPoolStats } from "../../fixtures";
import type { AdminPoolStats } from "../../../types";

const meta: Meta<typeof PoolPanel> = {
  title: "Compositions/Admin/PoolPanel",
  component: PoolPanel,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof PoolPanel>;

const emptyPoolStats: AdminPoolStats = {
  totals: { live: 0, delisted: 0, newLast24h: 0, sourcesEnabled: 0, sourcesTotal: 0, tagCoveragePct: 0 },
  functionMix: [],
  tzBands: [
    { band: "americas", count: 0, share: 0 },
    { band: "emea", count: 0, share: 0 },
    { band: "apac", count: 0, share: 0 },
    { band: "unassigned", count: 0, share: 0 },
  ],
  freshness: [
    { bucket: "24h", count: 0 },
    { bucket: "2-7d", count: 0 },
    { bucket: "8-30d", count: 0 },
    { bucket: "older", count: 0 },
  ],
  concentration: { topCompanies: [], top10Count: 0, restCount: 0 },
};

export const Loading: Story = {
  args: { loading: true },
};

export const Empty: Story = {
  args: { loading: false, stats: emptyPoolStats },
};

export const ErrorWithRetry: Story = {
  args: {
    loading: false,
    error: "Couldn't load pool stats. Check your connection and try again.",
    onRetry: () => console.log("retry"),
  },
};

export const Populated: Story = {
  args: { loading: false, stats: adminPoolStats },
};
