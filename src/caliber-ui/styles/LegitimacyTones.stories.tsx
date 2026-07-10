import type { Meta, StoryObj } from "@storybook/react";
import { Tag } from "../components/Tag";
import { legitimacyTone, legitimacyLabel } from "../lib/legitimacy";
import type { LegitimacyTier } from "../../types";

const meta: Meta = {
  title: "Tokens/Legitimacy tones",
};
export default meta;
type Story = StoryObj;

const tiers: LegitimacyTier[] = ["verified", "clear", "suspicious", "ghost", "scam"];

// The tier → tone → Tag matrix (§11.8): the single mapping every legitimacy
// pill in the app routes through (`legitimacyTone` in
// src/caliber-ui/lib/legitimacy.tsx).
export const Matrix: Story = {
  render: () => (
    <table style={{ borderCollapse: "collapse", font: "var(--type-body)" }}>
      <thead>
        <tr>
          {["Tier", "Tone", "Tag"].map((h) => (
            <th key={h} style={{ textAlign: "left", padding: "8px 16px", borderBottom: "1px solid var(--border-strong)", font: "var(--type-label)" }}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {tiers.map((tier) => {
          const tone = legitimacyTone(tier);
          return (
            <tr key={tier}>
              <td style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)" }}>{tier}</td>
              <td style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", color: "var(--text-muted)" }}>{tone}</td>
              <td style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)" }}>
                <Tag tone={tone}>{legitimacyLabel(tier)}</Tag>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  ),
};
