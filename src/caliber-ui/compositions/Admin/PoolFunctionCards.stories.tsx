import type { Meta, StoryObj } from "@storybook/react";
import { PoolFunctionCards } from "./PoolFunctionCards";
import { adminPoolStats } from "../../fixtures";

const meta: Meta<typeof PoolFunctionCards> = {
  title: "Compositions/Admin/PoolFunctionCards",
  component: PoolFunctionCards,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof PoolFunctionCards>;

export const Populated: Story = {
  args: { mix: adminPoolStats.functionMix },
};
