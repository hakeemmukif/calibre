import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { JobRow } from "./JobRow";
import { jobs } from "../../fixtures";

const meta: Meta<typeof JobRow> = {
  title: "Compositions/Feed/JobRow",
  component: JobRow,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof JobRow>;

const noop = () => console.log("action");

export const Verified: Story = {
  args: { job: jobs.find((j) => j.legitimacy.tier === "verified")!, onOpen: noop, onSave: noop, onDismiss: noop },
};

export const Clear: Story = {
  args: { job: jobs.find((j) => j.legitimacy.tier === "clear")!, onOpen: noop, onSave: noop, onDismiss: noop },
};

export const Suspicious: Story = {
  args: { job: jobs.find((j) => j.legitimacy.tier === "suspicious")!, onOpen: noop, onSave: noop, onDismiss: noop },
};

export const Ghost: Story = {
  args: { job: jobs.find((j) => j.legitimacy.tier === "ghost")!, onOpen: noop, onSave: noop, onDismiss: noop },
};

export const Scam: Story = {
  args: { job: jobs.find((j) => j.legitimacy.tier === "scam")!, onOpen: noop, onSave: noop, onDismiss: noop },
};

export const IsNew: Story = {
  args: { job: jobs.find((j) => j.isNew)!, onOpen: noop, onSave: noop, onDismiss: noop },
};

// "Saved" and "dismissing" aren't part of JobRow's props (see component-inventory
// §1 — the composition only takes job/onOpen/onSave/onDismiss); these stories
// layer the visual state on top via a decorator, without adding props to JobRow.
export const Saved: Story = {
  render: () => (
    <div style={{ position: "relative" }}>
      <JobRow job={jobs[0]} onOpen={noop} onSave={noop} onDismiss={noop} />
      <span
        style={{
          position: "absolute",
          top: 10,
          right: 10,
          font: "700 11px/1 var(--font-body)",
          color: "var(--fit-strong)",
          background: "var(--fit-strong-soft)",
          padding: "4px 8px",
          borderRadius: "var(--radius-pill, 999px)",
        }}
      >
        Saved
      </span>
    </div>
  ),
};

export const Dismissing: Story = {
  render: () => (
    <div style={{ opacity: 0.35, transform: "scale(0.98)", transition: "opacity 300ms, transform 300ms" }}>
      <JobRow job={jobs[1]} onOpen={noop} onSave={noop} onDismiss={noop} />
    </div>
  ),
};
