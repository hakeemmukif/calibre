"use client";
import * as React from "react";

export type FitBarTone = "good" | "warn" | "weak";

export interface FitBarProps extends React.HTMLAttributes<HTMLDivElement> {
  label?: React.ReactNode;
  /** 0–100. */
  value?: number;
  /** Override the right-hand readout text (defaults to `${value}%`). */
  display?: string;
  tone?: FitBarTone;
}

// FitBar — a labeled progress row for score breakdowns. Tone tints the fill;
// `display` overrides the right-hand readout text.
export function FitBar({ label, value = 0, display, tone, style, ...rest }: FitBarProps) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  const fill =
    tone === "good"
      ? "var(--fit-strong)"
      : tone === "warn"
        ? "var(--fit-mid)"
        : tone === "weak"
          ? "var(--fit-weak)"
          : "var(--gradient-score)";
  return (
    <div style={{ marginBottom: 4, ...style }} {...rest}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <span style={{ font: "var(--type-caption)", color: "var(--text-body)" }}>{label}</span>
        <span style={{ font: "var(--type-caption)", color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
          {display || `${v}%`}
        </span>
      </div>
      <div style={{ height: 6, borderRadius: "var(--radius-bar, 999px)", background: "var(--surface-sunken)", overflow: "hidden" }}>
        <div
          style={{
            height: "100%",
            width: `${v}%`,
            borderRadius: "var(--radius-bar, 999px)",
            background: fill,
            transition: "width var(--transition)",
          }}
        />
      </div>
    </div>
  );
}
