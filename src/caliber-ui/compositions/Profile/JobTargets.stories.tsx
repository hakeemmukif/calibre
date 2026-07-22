import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { JobTargets } from "./JobTargets";
import type { Profile } from "../../../types";

const meta: Meta<typeof JobTargets> = {
  title: "Compositions/Profile/JobTargets",
  component: JobTargets,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof JobTargets>;

const baseProfile: Profile = {
  baseCountry: "MY",
  relocation: "stay",
  scheduleFlex: "any-hours",
  employmentPref: "any",
  displayLocation: "Kuala Lumpur, Malaysia",
  targetRole: "Backend Engineer",
  salaryMin: 8000,
  salaryMax: 12000,
  salaryCurrency: "MYR",
  salaryCadence: "monthly",
  attrProvenance: { displayLocation: "resume", targetRole: "user", salary: "user" },
  updatedAt: "2026-07-22T00:00:00.000Z",
};

export const Populated: Story = {
  args: { profile: baseProfile, busy: false, onSave: () => {} },
};

export const Empty: Story = {
  args: {
    profile: {
      ...baseProfile,
      displayLocation: null,
      targetRole: null,
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      salaryCadence: null,
      attrProvenance: {},
    },
    busy: false,
    onSave: () => {},
  },
};

export const Busy: Story = {
  args: { profile: baseProfile, busy: true, onSave: () => {} },
};
