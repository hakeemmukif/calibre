import type { Meta, StoryObj } from "@storybook/react";

const meta: Meta = {
  title: "Tokens/Typography",
};
export default meta;
type Story = StoryObj;

const scale: { token: string; sample: string }[] = [
  { token: "--type-h1", sample: "Verified jobs, no ghosts" },
  { token: "--type-h2", sample: "Your feed, scored for fit + legitimacy" },
  { token: "--type-h3", sample: "Senior Backend Engineer, Payments" },
  { token: "--type-body-lg", sample: "Every posting scored for fit and legitimacy." },
  { token: "--type-body", sample: "6 yrs Node.js experience matches the payments team's stack." },
  { token: "--type-label", sample: "JOB POSTING URL" },
  { token: "--type-caption", sample: "Grab · Remote · APAC" },
  { token: "--type-eyebrow", sample: "SINCE LAST SCAN" },
];

export const Scale: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {scale.map((s) => (
        <div key={s.token}>
          <div style={{ font: "var(--type-caption)", color: "var(--text-faint)", marginBottom: 4 }}>
            <code>{s.token}</code>
          </div>
          <div style={{ font: `var(${s.token})`, color: "var(--text-strong)" }}>{s.sample}</div>
        </div>
      ))}
    </div>
  ),
};
