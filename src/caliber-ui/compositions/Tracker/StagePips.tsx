"use client";
import * as React from "react";

export type Stage = 0 | 1 | 2 | 3;

export interface StagePipsProps {
  stage: Stage;
}

const STAGES: string[] = ["Applied", "Screen", "Interview", "Decision"];

// StagePips — the 4-stage tracker pipeline (F5): Applied → Screen →
// Interview → Decision. Pips up to and including `stage` read as reached;
// the current stage gets an accent ring, later ones sit dim.
export function StagePips({ stage }: StagePipsProps) {
  return (
    <div style={{ display: "flex", alignItems: "center" }}>
      {STAGES.map((label, i) => {
        const reached = i <= stage;
        const current = i === stage;
        return (
          <React.Fragment key={label}>
            {i > 0 && (
              <div
                style={{
                  width: 18,
                  height: 2,
                  flex: "none",
                  background: i <= stage ? "var(--accent)" : "var(--border)",
                }}
              />
            )}
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <div
                style={{
                  width: current ? 11 : 8,
                  height: current ? 11 : 8,
                  borderRadius: "50%",
                  flex: "none",
                  background: reached ? "var(--accent)" : "var(--border-strong)",
                  opacity: reached ? 1 : 0.3,
                  boxShadow: current ? "0 0 0 3px var(--accent-soft)" : "none",
                  transition: "box-shadow var(--transition), background var(--transition)",
                }}
              />
              <span
                style={{
                  font: "var(--type-eyebrow)",
                  color: current ? "var(--text-strong)" : reached ? "var(--text-muted)" : "var(--text-faint)",
                  whiteSpace: "nowrap",
                }}
              >
                {label}
              </span>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}
