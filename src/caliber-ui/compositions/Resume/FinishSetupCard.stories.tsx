import type { Meta, StoryObj } from "@storybook/react";
import { FinishSetupCard } from "./FinishSetupCard";

const meta: Meta<typeof FinishSetupCard> = {
  title: "Compositions/Resume/FinishSetupCard",
  component: FinishSetupCard,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof FinishSetupCard>;

export const RoleAndLocationMissing: Story = {
  args: { needsTargetRole: true, needsLocation: true, busy: false, onSubmit: () => {} },
};

export const RoleOnlyMissing: Story = {
  args: { needsTargetRole: true, needsLocation: false, busy: false, onSubmit: () => {} },
};

export const WithError: Story = {
  args: {
    needsTargetRole: true,
    needsLocation: true,
    busy: false,
    error: "Couldn't update the profile.",
    onSubmit: () => {},
  },
};
