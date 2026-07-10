import type { Meta, StoryObj } from "@storybook/react";
import { Card, type CardPadding } from "./Card";
import { ScoreBadge } from "./ScoreBadge";
import { Tag } from "./Tag";

const meta: Meta<typeof Card> = {
  title: "Primitives/Card",
  component: Card,
};
export default meta;
type Story = StoryObj<typeof Card>;

const paddings: CardPadding[] = ["none", "sm", "md", "lg"];

export const Default: Story = {
  render: () => (
    <Card style={{ width: 320 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ font: "var(--type-h3)", color: "var(--text-strong)" }}>Senior Product Designer</div>
          <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 2 }}>Linear · Remote</div>
        </div>
        <ScoreBadge score={4.4} size="sm" />
      </div>
      <div style={{ marginTop: 12 }}>
        <Tag tone="good">Strong match</Tag>
      </div>
    </Card>
  ),
};

export const Paddings: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 16 }}>
      {paddings.map((padding) => (
        <Card key={padding} padding={padding} style={{ width: 160 }}>
          <span style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>padding: {padding}</span>
        </Card>
      ))}
    </div>
  ),
};

export const Interactive: Story = {
  render: () => (
    <Card interactive style={{ width: 240 }}>
      <div style={{ font: "var(--type-label)", color: "var(--text-strong)" }}>Notion</div>
      <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 4 }}>
        Hover to see the lift — used for clickable job rows.
      </div>
    </Card>
  ),
};
