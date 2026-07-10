"use client";
import * as React from "react";

export type AvatarSize = "sm" | "md" | "lg";

export interface AvatarProps extends React.HTMLAttributes<HTMLDivElement> {
  name?: string;
  size?: AvatarSize;
  /** Square tile for companies; round (default) for people. */
  square?: boolean;
  src?: string;
}

// Avatar — initials in a tinted tile. `square` for companies, round for people.
export function Avatar({ name = "", size = "md", square = false, src, style, ...rest }: AvatarProps) {
  const dims: Record<AvatarSize, number> = { sm: 26, md: 36, lg: 46 };
  const fonts: Record<AvatarSize, number> = { sm: 11, md: 14, lg: 17 };
  const d = dims[size] ?? dims.md;
  const initials =
    String(name)
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0] || "")
      .join("")
      .toUpperCase() || "•";
  return (
    <div
      style={{
        width: d,
        height: d,
        flex: "none",
        borderRadius: square ? "var(--radius-sm)" : "50%",
        background: "var(--surface-sunken)",
        color: "var(--text-strong)",
        display: "grid",
        placeItems: "center",
        font: `600 ${fonts[size] ?? 14}px/1 var(--font-display)`,
        letterSpacing: "0.01em",
        overflow: "hidden",
        border: "1px solid var(--border-faint)",
        ...style,
      }}
      {...rest}
    >
      {src ? (
        <img src={src} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (
        initials
      )}
    </div>
  );
}
