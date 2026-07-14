import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { ProfileTargets } from "./ProfileTargets";
import type { EmploymentPref, Profile, RelocationPref, ScheduleFlex } from "../../../types";

const meta: Meta<typeof ProfileTargets> = {
  title: "Compositions/Profile/ProfileTargets",
  component: ProfileTargets,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof ProfileTargets>;

const baseProfile: Profile = {
  baseCountry: "MY",
  relocation: "stay",
  scheduleFlex: "any-hours",
  employmentPref: "any",
  updatedAt: "2026-07-12T00:00:00.000Z",
};

const noop = { onRelocationChange: () => {}, onScheduleChange: () => {}, onEmploymentChange: () => {}, onPresetSelect: () => {} };

// Controlled wrapper so the preset row + all three pills are clickable in Canvas.
function PopulatedDemo() {
  const [profile, setProfile] = React.useState<Profile>(baseProfile);
  return (
    <ProfileTargets
      profile={profile}
      busy={false}
      onRelocationChange={(relocation: RelocationPref) => setProfile((p) => ({ ...p, relocation }))}
      onScheduleChange={(scheduleFlex: ScheduleFlex) => setProfile((p) => ({ ...p, scheduleFlex }))}
      onEmploymentChange={(employmentPref: EmploymentPref) => setProfile((p) => ({ ...p, employmentPref }))}
      onPresetSelect={(dials) => setProfile((p) => ({ ...p, ...dials }))}
    />
  );
}

export const Populated: Story = {
  render: () => <PopulatedDemo />,
};

export const OpenToRelocate: Story = {
  args: { profile: { ...baseProfile, relocation: "open" }, busy: false, ...noop },
};

export const Busy: Story = {
  args: { profile: baseProfile, busy: true, ...noop },
};
