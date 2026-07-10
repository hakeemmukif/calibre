"use client";
import * as React from "react";

export type ScoreSize = "sm" | "md" | "lg";
export type ScoreTone = "strong" | "mid" | "weak" | "ghost";

export interface ScoreBadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  score: number | string;
  outOf?: number;
  size?: ScoreSize;
  /** Force a tier color; otherwise routed from the numeric score. */
  tone?: ScoreTone;
  label?: string;
}

// ScoreBadge — the fit score, the product's signature element. A ring whose
// fill and color encode the tier (strong / mid / weak / ghost), with the number
// in the middle. Color routes through the fit system.
export function ScoreBadge({ score, outOf = 5, size = "md", tone, label, style, ...rest }: ScoreBadgeProps) {
  const num = Number(score);
  const dims: Record<ScoreSize, { d: number; stroke: number; font: number; sub: number }> = {
    sm: { d: 46, stroke: 3.5, font: 15, sub: 9 },
    md: { d: 58, stroke: 4, font: 19, sub: 10 },
    lg: { d: 74, stroke: 5, font: 25, sub: 11 },
  };
  const s = dims[size] ?? dims.md;

  let fg: string;
  if (tone === "ghost") fg = "var(--ghost)";
  else if (tone === "strong") fg = "var(--fit-strong)";
  else if (num >= 4.0) fg = "var(--fit-strong)";
  else if (num >= 3.0) fg = "var(--fit-mid)";
  else fg = "var(--fit-weak)";

  const r = (s.d - s.stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, (Number.isFinite(num) ? num : 0) / outOf));
  const shown = typeof score === "string" ? score : Number.isFinite(num) ? num.toFixed(1) : score;

  const ring = (
    <div style={{ position: "relative", width: s.d, height: s.d, flex: "none" }}>
      <svg width={s.d} height={s.d} viewBox={`0 0 ${s.d} ${s.d}`} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={s.d / 2} cy={s.d / 2} r={r} fill="none" stroke="var(--surface-sunken)" strokeWidth={s.stroke} />
        <circle
          cx={s.d / 2}
          cy={s.d / 2}
          r={r}
          fill="none"
          stroke={fg}
          strokeWidth={s.stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
          style={{ transition: "stroke-dashoffset var(--transition)" }}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "grid",
          placeItems: "center",
          font: `700 ${s.font}px/1 var(--font-display)`,
          color: fg,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {shown}
      </div>
    </div>
  );

  if (!label) {
    return (
      <div style={style} {...rest}>
        {ring}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5, ...style }} {...rest}>
      {ring}
      <span
        style={{
          font: `600 ${s.sub}px/1 var(--font-body)`,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--text-muted)",
        }}
      >
        {label}
      </span>
    </div>
  );
}
