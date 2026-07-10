import type { Meta, StoryObj } from "@storybook/react";
import { AppliedButton } from "./AppliedButton";

const meta: Meta<typeof AppliedButton> = {
  title: "Compositions/Apply/AppliedButton",
  component: AppliedButton,
  parameters: { layout: "centered" },
};
export default meta;
type Story = StoryObj<typeof AppliedButton>;

export const Idle: Story = {
  args: { applied: false, onMarkApplied: () => Promise.resolve() },
};

// Confirming/error are transient local state around the in-flight
// onMarkApplied() call, not props — click "Mark as applied" in these two
// stories to drive the component into each state live.
export const Confirming: Story = {
  args: { applied: false, onMarkApplied: () => new Promise(() => {}) },
  parameters: { docs: { description: { story: "Click the button — the promise never resolves, pinning the confirming state." } } },
};

export const Applied: Story = {
  args: { applied: true, appliedAgo: "2d ago", onMarkApplied: () => Promise.resolve() },
};

export const ErrorRetry: Story = {
  args: { applied: false, onMarkApplied: () => Promise.reject(new Error("network")) },
  parameters: { docs: { description: { story: "Click the button — the promise rejects, showing the error + retry state." } } },
};
