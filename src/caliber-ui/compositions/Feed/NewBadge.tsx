"use client";
import * as React from "react";

export interface NewBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  label?: string;
}

// NewBadge — the one new near-primitive (component-inventory.md §1): a
// styled Chip-sized dot+label marking a job as new since the last visit.
export function NewBadge({ label = "New", style, ...rest }: NewBadgeProps) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 8px 3px 6px",
        borderRadius: "var(--radius-pill, 999px)",
        background: "var(--accent-soft)",
        font: "700 10.5px/1 var(--font-body)",
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: "var(--accent-ink)",
        whiteSpace: "nowrap",
        ...style,
      }}
      {...rest}
    >
      <span
        aria-hidden="true"
        style={{
          width: 5,
          height: 5,
          borderRadius: "50%",
          background: "var(--accent)",
          flex: "none",
        }}
      />
      {label}
    </span>
  );
}
