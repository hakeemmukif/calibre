"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import type { SummaryStripStats } from "../../../types";

export type { SummaryStripStats };

export interface SummaryStripProps {
  stats: SummaryStripStats;
}

// SummaryStrip — the hero stat row (§11.8): Scanned today · Worth your time ·
// Flagged ghost/scam (drawn in --accent-ink) · Since last scan. Tabular
// numerals throughout.
export function SummaryStrip({ stats }: SummaryStripProps) {
  const cells: { label: string; value: number; tone?: string }[] = [
    { label: "Scanned today", value: stats.scanned },
    { label: "Worth your time", value: stats.worth },
    { label: "Flagged ghost/scam", value: stats.flagged, tone: "var(--accent-ink)" },
    // Post-pool-cutover (DECISION A): eligibility (tz/schedule/employment)
    // demotes rank, never hides — so `excluded` counts ONLY the one surviving
    // hard-hide, relocation "stay" hiding abroad roles. Label says exactly that.
    { label: "Excluded · requires relocation abroad", value: stats.excluded },
    { label: "Since last scan", value: stats.sinceLast },
  ];
  return (
    <Card padding="none" elevation="none" style={{ background: "var(--surface-sunken)", border: "none" }}>
      <div style={{ display: "flex" }}>
        {cells.map((c, i) => (
          <div
            key={c.label}
            style={{
              flex: 1,
              padding: "16px 20px",
              borderLeft: i > 0 ? "1px solid var(--border)" : "none",
            }}
          >
            <div
              style={{
                font: "700 26px/1 var(--font-display)",
                color: c.tone ?? "var(--text-strong)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {c.value}
            </div>
            <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 4 }}>{c.label}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}
