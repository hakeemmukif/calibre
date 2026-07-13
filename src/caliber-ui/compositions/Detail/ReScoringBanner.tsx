"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { StageGlyph } from "../Feed/ScanProgress";

export function ReScoringBanner({ phase, otherActive }: { phase: "fetching" | "scoring" | "done"; otherActive: number }) {
  const label = phase === "done" ? "Updated just now" : phase === "fetching" ? "Re-scoring this role — reading the posting" : "Re-scoring this role — scoring fit";
  return (
    <Card padding="sm" style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <StageGlyph state={phase === "done" ? "done" : "active"} size={22} />
        <div style={{ flex: 1 }}>
          <div style={{ font: "var(--type-label)", color: "var(--text-strong)" }}>
            {label}
            {phase !== "done" && otherActive > 0 && (
              <span style={{ color: "var(--text-muted)" }}>{` · ${otherActive} other check${otherActive === 1 ? "" : "s"} running`}</span>
            )}
          </div>
          {phase !== "done" && (
            <div style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>runs in the background — you can leave this page</div>
          )}
        </div>
      </div>
    </Card>
  );
}
