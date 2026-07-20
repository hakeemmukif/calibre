"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import type { AdminPoolStats } from "../../../types";

const BUCKET_LABELS: Record<string, string> = {
  engineering: "Engineering",
  data: "Data",
  product: "Product",
  design: "Design",
  sales: "Sales",
  marketing: "Marketing",
  cs_support: "CS & Support",
  people_hr: "People & HR",
  finance_legal: "Finance & Legal",
  ops_admin: "Ops & Admin",
  leadership: "Leadership",
  other: "Other",
};

export interface PoolFunctionCardsProps {
  mix: AdminPoolStats["functionMix"];
}

// PoolFunctionCards — grid of 12 stat cards, one per function bucket (spec
// §3/§4): eyebrow label, --type-h1 tabular count, "N% of pool" caption. The
// largest bucket's numeral goes in --accent-ink with a --border-strong top
// rule — the one place the red brand accent appears on this tab (spec
// §1.3). The sparkline slot below the count is intentionally empty in v1
// (spec §1.1 static-v1: visually reserved, wired later without rework).
export function PoolFunctionCards({ mix }: PoolFunctionCardsProps) {
  const maxCount = mix.reduce((m, b) => Math.max(m, b.count), 0);
  // Exactly one winner on ties — the first bucket (lowest index, pinned
  // FUNCTION_BUCKET_IDS order) with the max count gets the red numeral.
  const winnerIndex = maxCount > 0 ? mix.findIndex((b) => b.count === maxCount) : -1;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
      {mix.map((b, i) => {
        const isLargest = i === winnerIndex;
        return (
          <Card key={b.bucket} padding="sm" style={isLargest ? { borderTop: "2px solid var(--border-strong)" } : undefined}>
            <div
              style={{
                font: "var(--type-eyebrow)",
                color: "var(--text-muted)",
                textTransform: "uppercase",
                letterSpacing: "var(--tracking-caps)",
              }}
            >
              {BUCKET_LABELS[b.bucket] ?? b.bucket}
            </div>
            <div
              style={{
                font: "var(--type-h1)",
                color: isLargest ? "var(--accent-ink)" : "var(--text-strong)",
                fontVariantNumeric: "tabular-nums",
                marginTop: 4,
              }}
            >
              {b.count.toLocaleString()}
            </div>
            <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 2 }}>
              {b.share}% of pool
            </div>
            {/* Sparkline slot — reserved-empty in static v1 (spec §1.1) */}
            <div style={{ height: 20, marginTop: 8 }} />
          </Card>
        );
      })}
    </div>
  );
}
