import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { ProfileTargets } from "./ProfileTargets";
import type { Profile, RelocationPref } from "../../../types";

const meta: Meta<typeof ProfileTargets> = {
  title: "Compositions/Profile/ProfileTargets",
  component: ProfileTargets,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof ProfileTargets>;

const baseProfile: Profile = { baseCountry: "MY", relocation: "stay", updatedAt: "2026-07-12T00:00:00.000Z" };

// Controlled wrapper so the relocation pill is clickable in Canvas.
function PopulatedDemo() {
  const [profile, setProfile] = React.useState<Profile>(baseProfile);
  return (
    <ProfileTargets
      profile={profile}
      busy={false}
      onRelocationChange={(relocation: RelocationPref) => setProfile((p) => ({ ...p, relocation }))}
    />
  );
}

export const Populated: Story = {
  render: () => <PopulatedDemo />,
};

export const OpenToRelocate: Story = {
  args: { profile: { ...baseProfile, relocation: "open" }, busy: false, onRelocationChange: () => {} },
};

export const Busy: Story = {
  args: { profile: baseProfile, busy: true, onRelocationChange: () => {} },
};
