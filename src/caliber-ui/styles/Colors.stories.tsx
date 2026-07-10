import type { Meta, StoryObj } from "@storybook/react";

const meta: Meta = {
  title: "Tokens/Colors",
};
export default meta;
type Story = StoryObj;

const groups: { title: string; tokens: string[] }[] = [
  { title: "Surfaces", tokens: ["--bg-app", "--surface", "--surface-sunken", "--bg-subtle"] },
  { title: "Borders", tokens: ["--border", "--border-faint", "--border-strong"] },
  { title: "Accent", tokens: ["--accent", "--accent-hover", "--accent-soft", "--accent-ink"] },
  { title: "Fit / signal", tokens: ["--fit-strong", "--fit-strong-soft", "--fit-mid", "--fit-mid-soft", "--fit-weak", "--fit-weak-soft", "--ghost", "--ghost-soft"] },
  { title: "Status", tokens: ["--success", "--success-soft", "--danger-ink", "--danger-soft", "--verified", "--verified-soft"] },
  { title: "Text", tokens: ["--text-strong", "--text-body", "--text-muted", "--text-faint"] },
];

function Swatch({ token }: { token: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, width: 140 }}>
      <div
        style={{
          height: 56,
          borderRadius: "var(--radius-md)",
          background: `var(${token})`,
          border: "1px solid var(--border)",
        }}
      />
      <code style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>{token}</code>
    </div>
  );
}

export const AllGroups: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      {groups.map((g) => (
        <div key={g.title}>
          <div style={{ font: "var(--type-label)", color: "var(--text-strong)", marginBottom: 10 }}>{g.title}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
            {g.tokens.map((t) => (
              <Swatch key={t} token={t} />
            ))}
          </div>
        </div>
      ))}
    </div>
  ),
};
