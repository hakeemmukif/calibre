"use client";
import * as React from "react";
import { Icon } from "./Icon";

export type ChipVariant = "default" | "filter";

export interface ChipProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  variant?: ChipVariant;
  selected?: boolean;
  dashed?: boolean;
  iconLeft?: string;
}

// Chip — a selectable token used for filters, skills, and tags-you-pick.
//   variant "filter"  → selected becomes a solid ink pill (segmented control feel)
//   default           → selected becomes an accent tint
//   dashed            → an "add" affordance with a dashed outline
export function Chip({
  variant = "default",
  selected = false,
  dashed = false,
  iconLeft,
  onClick,
  children,
  style,
  ...rest
}: ChipProps) {
  const [hover, setHover] = React.useState(false);

  let skin: { bg: string; fg: string; bd: string };
  if (dashed) {
    skin = { bg: "transparent", fg: "var(--text-muted)", bd: "1.5px dashed var(--border-strong)" };
  } else if (variant === "filter") {
    skin = selected
      ? { bg: "var(--text-strong)", fg: "var(--surface)", bd: "1px solid var(--text-strong)" }
      : { bg: "var(--surface)", fg: "var(--text-body)", bd: "1px solid var(--border-strong)" };
  } else {
    skin = selected
      ? { bg: "var(--accent-soft)", fg: "var(--accent-ink)", bd: "1px solid var(--accent)" }
      : { bg: "var(--surface)", fg: "var(--text-body)", bd: "1px solid var(--border-strong)" };
  }

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "8px 13px",
        borderRadius: "var(--radius-pill, 999px)",
        font: "500 13px/1 var(--font-body)",
        background: skin.bg,
        color: skin.fg,
        border: skin.bd,
        cursor: "pointer",
        filter: hover && !selected ? "brightness(0.98)" : "none",
        transition: "background var(--transition), border-color var(--transition), color var(--transition)",
        ...style,
      }}
      {...rest}
    >
      {iconLeft && <Icon name={iconLeft} size={13} strokeWidth={2} />}
      {children}
    </button>
  );
}
