"use client";
import * as React from "react";

export interface SignalBarProps {
  segments: { value: number; color: string }[];
}

// SignalBar — a proportional multi-segment track (met/buried/gap). Local to
// the Tailor composition; the single-fill FitBar primitive covers the ATS row.
export function SignalBar({ segments }: SignalBarProps) {
  return (
    <div style={{ display: "flex", height: 9, borderRadius: 6, overflow: "hidden", background: "var(--surface-sunken)" }}>
      {segments
        .filter((s) => s.value > 0)
        .map((s, i) => (
          <div key={i} style={{ flex: s.value, background: s.color }} />
        ))}
    </div>
  );
}
