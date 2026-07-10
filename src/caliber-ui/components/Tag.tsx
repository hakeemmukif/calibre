"use client";
import * as React from "react";
import { Icon } from "./Icon";

export type TagTone = "good" | "verified" | "warn" | "ghost" | "danger" | "neutral";

export interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: TagTone;
}

// Tag — a small status pill. Tone routes through the fit / status system.
// `good` and `verified` carry a leading check so positives read at a glance.
export function Tag({ tone = "neutral", children, style, ...rest }: TagProps) {
  const map: Record<TagTone, { bg: string; fg: string; icon: string | null }> = {
    good: { bg: "var(--fit-strong-soft)", fg: "var(--fit-strong)", icon: "check" },
    verified: { bg: "var(--verified-soft)", fg: "var(--verified)", icon: "badge-check" },
    warn: { bg: "var(--fit-mid-soft)", fg: "var(--fit-mid)", icon: null },
    ghost: { bg: "var(--ghost-soft)", fg: "var(--ghost)", icon: null },
    danger: { bg: "var(--danger-soft)", fg: "var(--danger-ink)", icon: null },
    neutral: { bg: "var(--surface-sunken)", fg: "var(--text-muted)", icon: null },
  };
  const k = map[tone] ?? map.neutral;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "4px 9px",
        borderRadius: "var(--radius-pill, 999px)",
        font: "600 11.5px/1 var(--font-body)",
        color: k.fg,
        background: k.bg,
        whiteSpace: "nowrap",
        ...style,
      }}
      {...rest}
    >
      {k.icon && <Icon name={k.icon} size={12} strokeWidth={2.4} />}
      {children}
    </span>
  );
}
