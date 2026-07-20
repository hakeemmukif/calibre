"use client";
import * as React from "react";
import { Chip } from "../../components/Chip";
import type { AdminPoolStats } from "../../../types";

interface StripSegment {
  key: string;
  label: string;
  count: number;
  share: number;
  color: string;
}

// NOTE: no --accent-ink here — red is reserved for PoolFunctionCards' single
// largest-bucket numeral (spec §1.3's "one signal red" rule); tokens.css's
// fit-system comment says as much ("red is reserved as the brand action
// accent, not a fit color").
const PALETTE = ["var(--fit-strong)", "var(--fit-mid)", "var(--neutral-400)", "var(--text-strong)", "var(--fit-weak)"];
const OTHER_COLOR = "var(--neutral-300)";
const INLINE_LABEL_MIN_SHARE = 4;

// Segments < 4% share (spec §3c) collapse into a trailing "Other" segment —
// the strip stays readable instead of a wall of slivers.
function collapseSmall(segments: StripSegment[]): StripSegment[] {
  const big = segments.filter((s) => s.share >= INLINE_LABEL_MIN_SHARE);
  const small = segments.filter((s) => s.share < INLINE_LABEL_MIN_SHARE);
  if (small.length === 0) return big;
  const other = small.reduce(
    (acc, s) => ({ ...acc, count: acc.count + s.count, share: acc.share + s.share }),
    { key: "other", label: "Other", count: 0, share: 0, color: OTHER_COLOR },
  );
  return [...big, other];
}

// Strip — a 100%-stacked bar (FitBar's rounded-track geometry, not the FitBar
// component itself — FitBar only expresses one value/tone pair) + a Chip
// legend row underneath (spec §3: "Chip legends").
function Strip({ title, segments }: { title: string; segments: StripSegment[] }) {
  const collapsed = collapseSmall(segments);
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ font: "var(--type-h3)", color: "var(--text-strong)", marginBottom: 8 }}>{title}</div>
      <div
        style={{
          display: "flex",
          height: 10,
          borderRadius: "var(--radius-bar, 999px)",
          overflow: "hidden",
          background: "var(--surface-sunken)",
        }}
      >
        {collapsed.map((s) => (
          <div key={s.key} title={`${s.label}: ${s.share}%`} style={{ width: `${s.share}%`, background: s.color }} />
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
        {collapsed.map((s) => (
          <Chip key={s.key} style={{ cursor: "default" }}>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 999, background: s.color, marginRight: 2 }} />
            {s.label} <span style={{ fontVariantNumeric: "tabular-nums" }}>{s.share}%</span>
          </Chip>
        ))}
      </div>
    </div>
  );
}

const TZ_LABELS: Record<string, string> = { americas: "Americas", emea: "EMEA", apac: "APAC", unassigned: "Unassigned" };
const FRESHNESS_LABELS: Record<string, string> = {
  "24h": "Last 24h",
  "2-7d": "2–7 days",
  "8-30d": "8–30 days",
  older: "Older",
};

function sharePct(count: number, total: number): number {
  return total === 0 ? 0 : Math.round((count / total) * 1000) / 10;
}

export interface PoolStripsProps {
  tzBands: AdminPoolStats["tzBands"];
  freshness: AdminPoolStats["freshness"];
  concentration: AdminPoolStats["concentration"];
}

// PoolStrips — three full-width 100%-stacked strips (spec §3): TZ band,
// freshness, and company concentration. `unassigned` always renders in
// --neutral-300 (spec §3a). freshness/concentration carry no per-entry
// `share` in the contract (spec §4) — computed client-side here from counts.
export function PoolStrips({ tzBands, freshness, concentration }: PoolStripsProps) {
  const tzSegments: StripSegment[] = tzBands.map((b, i) => ({
    key: b.band,
    label: TZ_LABELS[b.band] ?? b.band,
    count: b.count,
    share: b.share,
    color: b.band === "unassigned" ? OTHER_COLOR : PALETTE[i % PALETTE.length],
  }));

  const freshTotal = freshness.reduce((sum, f) => sum + f.count, 0);
  const freshSegments: StripSegment[] = freshness.map((f, i) => ({
    key: f.bucket,
    label: FRESHNESS_LABELS[f.bucket] ?? f.bucket,
    count: f.count,
    share: sharePct(f.count, freshTotal),
    color: PALETTE[i % PALETTE.length],
  }));

  const concentrationTotal = concentration.top10Count + concentration.restCount;
  const concentrationSegments: StripSegment[] = [
    ...concentration.topCompanies.map((c, i) => ({
      key: c.company,
      label: c.company,
      count: c.count,
      share: sharePct(c.count, concentrationTotal),
      color: PALETTE[i % PALETTE.length],
    })),
    {
      key: "rest",
      label: "Rest of pool",
      count: concentration.restCount,
      share: sharePct(concentration.restCount, concentrationTotal),
      color: OTHER_COLOR,
    },
  ];

  return (
    <div>
      <Strip title="Timezone band" segments={tzSegments} />
      <Strip title="Freshness" segments={freshSegments} />
      <Strip title="Company concentration" segments={concentrationSegments} />
    </div>
  );
}
