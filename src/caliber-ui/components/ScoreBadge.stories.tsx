import type { Meta, StoryObj } from "@storybook/react";
import { ScoreBadge, type ScoreTone, type ScoreSize } from "./ScoreBadge";

const meta: Meta<typeof ScoreBadge> = {
  title: "Primitives/ScoreBadge",
  component: ScoreBadge,
};
export default meta;
type Story = StoryObj<typeof ScoreBadge>;

const tones: { tone: ScoreTone; score: number; label: string }[] = [
  { tone: "strong", score: 4.6, label: "Fit" },
  { tone: "mid", score: 3.2, label: "Fit" },
  { tone: "weak", score: 1.8, label: "Fit" },
  { tone: "ghost", score: 0, label: "No data" },
];
const sizes: ScoreSize[] = ["sm", "md", "lg"];

export const Default: Story = {
  args: { score: 4.3, outOf: 5, size: "md", label: "Fit" },
};

export const TonesAtEverySize: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {sizes.map((size) => (
        <div key={size} style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <span style={{ width: 40, font: "var(--type-caption)", color: "var(--text-muted)" }}>{size}</span>
          {tones.map(({ tone, score, label }) => (
            <ScoreBadge key={tone} tone={tone} score={score} size={size} label={label} />
          ))}
        </div>
      ))}
    </div>
  ),
};

export const NoLabel: Story = {
  args: { score: 4.9, outOf: 5, size: "lg" },
};
