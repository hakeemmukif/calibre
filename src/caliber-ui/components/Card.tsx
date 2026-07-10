"use client";
import * as React from "react";

export type CardPadding = "none" | "sm" | "md" | "lg";
export type CardElevation = "none" | "xs" | "sm" | "md" | "lg";
export type CardRadius = "sm" | "md" | "lg" | "xl";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  padding?: CardPadding;
  elevation?: CardElevation;
  radius?: CardRadius;
  interactive?: boolean;
}

// Card — the surface primitive. A clean panel with a hairline border and
// restrained elevation. `interactive` adds a hover lift.
export function Card({
  padding = "md",
  elevation = "sm",
  radius = "lg",
  interactive = false,
  onClick,
  style,
  children,
  ...rest
}: CardProps) {
  const [hover, setHover] = React.useState(false);
  const pads: Record<CardPadding, number> = { none: 0, sm: 14, md: 18, lg: 24 };
  const shadows: Record<CardElevation, string> = {
    none: "none",
    xs: "var(--shadow-xs)",
    sm: "var(--shadow-sm)",
    md: "var(--shadow-md)",
    lg: "var(--shadow-lg)",
  };
  const radii: Record<CardRadius, string> = {
    sm: "var(--radius-sm)",
    md: "var(--radius-md)",
    lg: "var(--radius-lg)",
    xl: "var(--radius-xl)",
  };
  const lifted = interactive && hover;
  return (
    <div
      onClick={onClick}
      onMouseEnter={interactive ? () => setHover(true) : undefined}
      onMouseLeave={interactive ? () => setHover(false) : undefined}
      style={{
        background: "var(--surface)",
        border: `1px solid ${lifted ? "var(--border-strong)" : "var(--border)"}`,
        borderRadius: radii[radius] ?? radii.lg,
        boxShadow: lifted ? "var(--shadow-md)" : (shadows[elevation] ?? shadows.sm),
        padding: pads[padding] ?? pads.md,
        cursor: interactive ? "pointer" : undefined,
        transition: "box-shadow var(--transition), border-color var(--transition)",
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}
