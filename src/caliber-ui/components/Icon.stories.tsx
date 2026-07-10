import type { Meta, StoryObj } from "@storybook/react";
import { Icon, type IconName } from "./Icon";

const meta: Meta<typeof Icon> = {
  title: "Primitives/Icon",
  component: Icon,
};
export default meta;
type Story = StoryObj<typeof Icon>;

const names: IconName[] = [
  "target", "circle-check", "badge-check", "check", "x", "users", "file-text", "mail",
  "trending-up", "radar", "sliders-horizontal", "sparkles", "send", "clock", "shield", "zap",
  "download", "upload", "refresh-cw", "arrow-right", "arrow-left", "chevron-down", "chevron-up",
  "calendar", "book-open", "bar-chart-3", "triangle-alert", "search", "ghost", "layers", "plus",
  "circle-help", "message-square", "pencil", "copy", "linkedin", "activity", "building",
];

export const Default: Story = {
  args: { name: "target", size: 24 },
};

export const AllIcons: Story = {
  render: () => (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 100px)", gap: 20 }}>
      {names.map((name) => (
        <div key={name} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
          <Icon name={name} size={22} style={{ color: "var(--text-strong)" }} />
          <span style={{ font: "var(--type-caption)", color: "var(--text-muted)", fontSize: 10 }}>{name}</span>
        </div>
      ))}
    </div>
  ),
};

export const UnknownFallsBackToCircle: Story = {
  args: { name: "not-a-real-icon" },
};
