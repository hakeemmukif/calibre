"use client";
import * as React from "react";
import { Icon } from "./Icon";

export type ButtonVariant =
  | "primary" | "secondary" | "soft" | "soft-accent" | "accent" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Lucide-style icon name rendered before the label. */
  iconLeft?: string;
  /** Lucide-style icon name rendered after the label. */
  iconRight?: string;
  fullWidth?: boolean;
}

// Button — the action primitive. Variants map to intent; everything is driven
// from tokens so it restyles with the theme.
//   primary     dark ink fill, the strongest CTA
//   secondary   white with hairline border
//   soft        quiet neutral fill
//   soft-accent accent tint (the "AI / tailor" action)
//   accent      solid accent fill (use on dark panels)
//   ghost       text only
export function Button({
  variant = "secondary",
  size = "md",
  iconLeft,
  iconRight,
  fullWidth = false,
  disabled = false,
  onClick,
  style,
  children,
  ...rest
}: ButtonProps) {
  const [hover, setHover] = React.useState(false);

  const sizes: Record<ButtonSize, { pad: string; font: number; gap: number; icon: number }> = {
    sm: { pad: "7px 12px", font: 13, gap: 6, icon: 15 },
    md: { pad: "10px 16px", font: 14, gap: 7, icon: 16 },
    lg: { pad: "13px 22px", font: 15, gap: 8, icon: 18 },
  };
  const s = sizes[size] ?? sizes.md;

  const skins: Record<ButtonVariant, { bg: string; fg: string; bd: string; hbg: string }> = {
    primary: { bg: "var(--text-strong)", fg: "var(--surface)", bd: "transparent", hbg: "#000" },
    secondary: { bg: "var(--surface)", fg: "var(--text-strong)", bd: "var(--border-strong)", hbg: "var(--bg-subtle)" },
    soft: { bg: "var(--surface-sunken)", fg: "var(--text-strong)", bd: "transparent", hbg: "var(--neutral-300)" },
    "soft-accent": { bg: "var(--accent-soft)", fg: "var(--accent-ink)", bd: "transparent", hbg: "var(--accent-soft)" },
    accent: { bg: "var(--accent)", fg: "var(--ink-900)", bd: "transparent", hbg: "var(--accent-hover)" },
    ghost: { bg: "transparent", fg: "var(--text-body)", bd: "transparent", hbg: "var(--surface-sunken)" },
  };
  const k = skins[variant] ?? skins.secondary;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: fullWidth ? "flex" : "inline-flex",
        width: fullWidth ? "100%" : undefined,
        alignItems: "center",
        justifyContent: "center",
        gap: s.gap,
        padding: s.pad,
        font: `600 ${s.font}px/1 var(--font-body)`,
        color: k.fg,
        background: hover && !disabled ? k.hbg : k.bg,
        border: `1px solid ${k.bd}`,
        borderRadius: "var(--radius-sm)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        whiteSpace: "nowrap",
        transition: "background var(--transition), border-color var(--transition), box-shadow var(--transition)",
        ...style,
      }}
      {...rest}
    >
      {iconLeft && <Icon name={iconLeft} size={s.icon} strokeWidth={2} />}
      {children}
      {iconRight && <Icon name={iconRight} size={s.icon} strokeWidth={2} />}
    </button>
  );
}
