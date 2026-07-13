"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { CheckRunRow } from "../Shell/CheckRunRow";
import type { CheckRun } from "@/features/url-check/checksStore";

export interface ScoringStatusCardProps {
  runs: CheckRun[];
  onOpen(jobId: string): void;
  onRetry(key: string): void;
  onPasteText(key: string): void;
  onDismiss(key: string): void;
}

export function ScoringStatusCard({ runs, onOpen, onRetry, onPasteText, onDismiss }: ScoringStatusCardProps) {
  if (runs.length === 0) return null;
  const active = runs.filter((r) => r.phase === "starting" || r.phase === "queued" || r.phase === "fetching" || r.phase === "scoring");
  return (
    <Card padding="md" style={{ maxWidth: 480, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent-ink)",
          animation: active.length > 0 ? "caliber-pulse 1.6s ease-in-out infinite alternate" : undefined }} />
        <div>
          <div style={{ font: "var(--type-label)", color: "var(--text-strong)" }}>
            {active.length > 0 ? `Scoring ${active.length} role${active.length === 1 ? "" : "s"} in parallel` : "Checks"}
          </div>
          <div style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>
            each takes about 30 seconds — keep browsing, results drop into your feed
          </div>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {runs.map((run) => (
          <CheckRunRow key={run.key} run={run} onOpen={onOpen} onRetry={onRetry} onPasteText={onPasteText} onDismiss={onDismiss} />
        ))}
      </div>
    </Card>
  );
}
