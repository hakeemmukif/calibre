import type { Meta, StoryObj } from "@storybook/react";
import { EvalResultCard } from "./EvalResultCard";
import { Card } from "../../components/Card";
import { jobs } from "../../fixtures";

const meta: Meta<typeof EvalResultCard> = {
  title: "Compositions/Eval/EvalResultCard",
  component: EvalResultCard,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof EvalResultCard>;

const noop = () => console.log("action");

export const Verified: Story = {
  args: { job: jobs.find((j) => j.legitimacy.tier === "verified")!, onOpen: noop, onSave: noop, onTailor: noop, onDismiss: noop },
};

export const Suspicious: Story = {
  args: { job: jobs.find((j) => j.legitimacy.tier === "suspicious")!, onOpen: noop, onSave: noop, onTailor: noop, onDismiss: noop },
};

export const Ghost: Story = {
  args: { job: jobs.find((j) => j.legitimacy.tier === "ghost")!, onOpen: noop, onSave: noop, onTailor: noop, onDismiss: noop },
};

export const Scam: Story = {
  args: { job: jobs.find((j) => j.legitimacy.tier === "scam")!, onOpen: noop, onSave: noop, onTailor: noop, onDismiss: noop },
};

export const LowFitHighLegit: Story = {
  args: { job: jobs.find((j) => j.legitimacy.tier === "clear")!, onOpen: noop, onSave: noop, onTailor: noop, onDismiss: noop },
};

export const AlreadyKnown: Story = {
  args: {
    job: jobs.find((j) => j.legitimacy.tier === "verified")!,
    onOpen: noop,
    onSave: noop,
    onTailor: noop,
    onDismiss: noop,
    alreadyKnownScopeLabel: "Remote",
  },
};

export const WebCheckFailed: Story = {
  args: {
    job: {
      ...jobs.find((j) => j.legitimacy.tier === "suspicious")!,
      legitimacy: {
        ...jobs.find((j) => j.legitimacy.tier === "suspicious")!.legitimacy,
        webEvidence: { status: "failed", reason: "search provider timeout" },
      },
    },
    onOpen: noop,
    onSave: noop,
    onTailor: noop,
    onDismiss: noop,
  },
};

export const LoadingSkeleton: Story = {
  render: () => (
    <Card style={{ maxWidth: 480 }}>
      <div style={{ display: "flex", gap: 16 }}>
        <div style={{ width: 74, height: 74, borderRadius: "50%", background: "var(--surface-sunken)" }} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ height: 18, width: "70%", background: "var(--surface-sunken)", borderRadius: 4 }} />
          <div style={{ height: 12, width: "45%", background: "var(--surface-sunken)", borderRadius: 4 }} />
          <div style={{ height: 12, width: "90%", background: "var(--surface-sunken)", borderRadius: 4 }} />
        </div>
      </div>
    </Card>
  ),
};
