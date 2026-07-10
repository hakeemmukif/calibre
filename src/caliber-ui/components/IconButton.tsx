"use client";
import * as React from "react";
import { Icon } from "./Icon";

export type IconButtonSize = "sm" | "md" | "lg";
export type IconButtonVariant = "ghost" | "soft" | "soft-accent";

export interface IconButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  icon: string;
  size?: IconButtonSize;
  variant?: IconButtonVariant;
  label?: string;
}

// IconButton — a square, icon-only button for toolbars and dense rows.
export function IconButton({
  icon, size = "md", variant = "ghost", onClick, label, style, ...rest
}: IconButtonProps) {
  const [hover, setHover] = React.useState(false);
  const dims: Record<IconButtonSize, number> = { sm: 30, md: 36, lg: 42 };
  const d = dims[size] ?? dims.md;
  const skins: Record<IconButtonVariant, { bg: string; fg: string; hbg: string }> = {
    ghost: { bg: "transparent", fg: "var(--text-muted)", hbg: "var(--surface-sunken)" },
    soft: { bg: "var(--surface-sunken)", fg: "var(--text-strong)", hbg: "var(--neutral-300)" },
    "soft-accent": { bg: "var(--accent-soft)", fg: "var(--accent-ink)", hbg: "var(--accent-soft)" },
  };
  const k = skins[variant] ?? skins.ghost;
  return (
    <button
      type="button"
      aria-label={label || icon}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: d, height: d, display: "grid", placeItems: "center",
        borderRadius: "var(--radius-sm)", border: "1px solid transparent",
        background: hover ? k.hbg : k.bg, color: k.fg, cursor: "pointer",
        transition: "background var(--transition)", ...style,
      }}
      {...rest}
    >
      <Icon name={icon} size={Math.round(d * 0.46)} strokeWidth={2} />
    </button>
  );
}
