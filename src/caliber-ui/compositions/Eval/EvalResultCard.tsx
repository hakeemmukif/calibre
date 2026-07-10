"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { ScoreBadge } from "../../components/ScoreBadge";
import { FitBar } from "../../components/FitBar";
import { Button } from "../../components/Button";
import { LegitimacyTag } from "../../lib/legitimacy";
import { toFitBarTone } from "../../lib/format";
import type { Job } from "../../../types";

export interface EvalResultCardProps {
  job: Job;
  onOpen(): void;
  onSave(): void;
}

// EvalResultCard — the single-URL verdict from UrlEvalBar (F2): ScoreBadge +
// FitBar breakdown + Tag (legitimacy foregrounded) + open/save actions.
export function EvalResultCard({ job, onOpen, onSave }: EvalResultCardProps) {
  return (
    <Card style={{ maxWidth: 480 }}>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <ScoreBadge score={job.score} size="lg" label="Fit" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ font: "var(--type-h3)", color: "var(--text-strong)" }}>{job.role}</span>
            <LegitimacyTag legitimacy={job.legitimacy} />
          </div>
          <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 3 }}>
            {job.company} · {job.meta}
          </div>
          <div style={{ font: "var(--type-body)", color: "var(--text-body)", marginTop: 8 }}>{job.legitimacy.summary}</div>
        </div>
      </div>

      {job.breakdown.length > 0 && (
        <div style={{ marginTop: 16 }}>
          {job.breakdown.map((b) => (
            <FitBar key={b.label} label={b.label} value={b.value} display={b.display} tone={toFitBarTone(b.tone)} />
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <Button variant="primary" iconRight="arrow-right" onClick={onOpen}>
          Open posting
        </Button>
        <Button variant="secondary" iconLeft="bookmark" onClick={onSave}>
          Save
        </Button>
      </div>
    </Card>
  );
}
