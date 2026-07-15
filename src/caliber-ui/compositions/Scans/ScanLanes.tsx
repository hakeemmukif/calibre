"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { StageGlyph } from "../Feed/ScanProgress";
import type { LiveJob, LiveState } from "../../../features/search/scanLive";

export interface ScanLanesProps {
  activeJobs: LiveJob[];
  counts: LiveState["counts"];
}

const PHASE_LABEL: Record<"fetching" | "readingJD" | "scoring" | "rescoring", string> = {
  fetching: "Fetching",
  readingJD: "Reading JD",
  scoring: "Scoring",
  rescoring: "Re-scoring",
};

// ScanLanes — one lane per in-flight concurrency slot during a live scan.
// Pure presentational: sorts activeJobs by slot, shows a phase glyph + label,
// title/company, and pulses the active row. Counts row below the lanes
// mirrors ScanProgress's honest-numbers convention. No fetching.
export function ScanLanes({ activeJobs, counts }: ScanLanesProps) {
  const sorted = [...activeJobs].sort((a, b) => a.slot - b.slot);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {sorted.map((job) => (
        <Card
          key={job.jobId}
          padding="sm"
          style={{ display: "flex", alignItems: "center", gap: 10, animation: "caliber-pulse 1.4s ease-in-out infinite alternate" }}
        >
          <StageGlyph state="active" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ font: "var(--type-label)", color: "var(--text-strong)" }}>
              {job.title} <span style={{ color: "var(--text-muted)" }}>· {job.company}</span>
            </div>
            <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 2 }}>
              {PHASE_LABEL[job.phase as keyof typeof PHASE_LABEL]}
            </div>
          </div>
        </Card>
      ))}
      <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
        {counts.scored}/{counts.total} · {counts.queued} queued
      </div>
    </div>
  );
}
