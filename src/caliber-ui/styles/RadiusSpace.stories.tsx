import type { Meta, StoryObj } from "@storybook/react";

const meta: Meta = {
  title: "Tokens/Radius & Space",
};
export default meta;
type Story = StoryObj;

const radii: string[] = ["--radius-sm", "--radius-md", "--radius-lg", "--radius-xl", "--radius-pill"];
const space: number[] = [4, 6, 8, 10, 12, 14, 16, 18, 20, 24];

export const Radius: Story = {
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
      {radii.map((r) => (
        <div key={r} style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "center" }}>
          <div style={{ width: 88, height: 64, background: "var(--surface-sunken)", border: "1px solid var(--border-strong)", borderRadius: `var(${r})` }} />
          <code style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>{r}</code>
        </div>
      ))}
    </div>
  ),
};

export const Space: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {space.map((s) => (
        <div key={s} style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: s, height: 20, background: "var(--accent)" }} />
          <code style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>{s}px</code>
        </div>
      ))}
    </div>
  ),
};
