import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { ProfileTargets, type ProfileDialsBundle } from "./ProfileTargets";
import type { Profile, RelocationPref, ScheduleFlex, EmploymentPref } from "../../../types";

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
  displayLocation: null,
  targetRole: null,
  salaryMin: null,
  salaryMax: null,
  salaryCurrency: null,
  salaryCadence: null,
  attrProvenance: {},
  updatedAt: "2026-07-12T00:00:00.000Z",
};

// Controlled wrapper so the pills + preset row are clickable in Canvas.
function PopulatedDemo() {
  const [profile, setProfile] = React.useState<Profile>(baseProfile);
  return (
    <ProfileTargets
      profile={profile}
      busy={false}
      onRelocationChange={(relocation: RelocationPref) => setProfile((p) => ({ ...p, relocation }))}
      onScheduleChange={(scheduleFlex: ScheduleFlex) => setProfile((p) => ({ ...p, scheduleFlex }))}
      onEmploymentChange={(employmentPref: EmploymentPref) => setProfile((p) => ({ ...p, employmentPref }))}
      onPresetSelect={(bundle: ProfileDialsBundle) => setProfile((p) => ({ ...p, ...bundle }))}
    />
  );
}

export const Populated: Story = {
  render: () => <PopulatedDemo />,
};

export const OpenToRelocate: Story = {
  args: {
    profile: { ...baseProfile, relocation: "open" },
    busy: false,
    onRelocationChange: () => {},
    onScheduleChange: () => {},
    onEmploymentChange: () => {},
    onPresetSelect: () => {},
  },
};

export const Busy: Story = {
  args: {
    profile: baseProfile,
    busy: true,
    onRelocationChange: () => {},
    onScheduleChange: () => {},
    onEmploymentChange: () => {},
    onPresetSelect: () => {},
  },
};
