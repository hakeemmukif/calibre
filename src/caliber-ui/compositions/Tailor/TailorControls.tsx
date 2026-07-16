"use client";
import * as React from "react";
import { Chip } from "../../components/Chip";
import { Button } from "../../components/Button";
import type { Job } from "../../../types";

export interface TailorControlsProps {
  job: Job;
  status: "configuring" | "analyzing";
  onAnalyze(): void;
}

// TailorControls — F6's entry panel (§3): emphasis chips drawn from
// `job.gaps`/`job.fit` (what the tailoring should lean into) + "Analyze fit".
// Chip selection is local UI state only — POST /api/tailor takes just
// `{ jobId }` (api-contract.md §3), so there's no emphasis field to forward.
export function TailorControls({ job, status, onAnalyze }: TailorControlsProps) {
  const allKeys = React.useMemo(() => [...job.gaps.map((g) => g.k), ...job.fit.map((f) => f.k)], [job]);
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set(allKeys));

  function toggle(k: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  const analyzing = status === "analyzing";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <div style={{ font: "var(--type-label)", color: "var(--text-strong)", marginBottom: 8 }}>
          Emphasize for {job.company}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {job.gaps.map((g) => (
            <Chip
              key={g.k}
              selected={selected.has(g.k)}
              iconLeft={g.tone === "warn" ? "triangle-alert" : "check"}
              onClick={() => toggle(g.k)}
              disabled={analyzing}
            >
              {g.k}
            </Chip>
          ))}
          {job.fit.map((f) => (
            <Chip key={f.k} selected={selected.has(f.k)} onClick={() => toggle(f.k)} disabled={analyzing}>
              {f.k}
            </Chip>
          ))}
        </div>
      </div>
      <div>
        <Button variant="soft-accent" iconLeft="sparkles" onClick={onAnalyze} disabled={analyzing}>
          {analyzing ? "Analyzing…" : "Analyze fit"}
        </Button>
      </div>
    </div>
  );
}
