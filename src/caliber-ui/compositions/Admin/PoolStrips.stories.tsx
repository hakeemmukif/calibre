import type { Meta, StoryObj } from "@storybook/react";
import { PoolStrips } from "./PoolStrips";
import { adminPoolStats } from "../../fixtures";

const meta: Meta<typeof PoolStrips> = {
  title: "Compositions/Admin/PoolStrips",
  component: PoolStrips,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof PoolStrips>;

export const Populated: Story = {
  args: {
    tzBands: adminPoolStats.tzBands,
    freshness: adminPoolStats.freshness,
    concentration: adminPoolStats.concentration,
  },
};
