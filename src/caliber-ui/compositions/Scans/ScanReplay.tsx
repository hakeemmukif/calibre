"use client";
// ScanReplay — the terminal-run replay for /scans/:id (M1 §4.3): three phased
// Card sections (Discover, Score, Legitimacy) built entirely from the
// persisted `ScanDetail`, plus a header of run stats. Presentational only —
// no fetching, no SSE (that's the page + the running-run useScanRun bridge).
import * as React from "react";
import { Card } from "../../components/Card";
import { Tag, type TagTone } from "../../components/Tag";
import { ScoreBadge } from "../../components/ScoreBadge";
import { Tabs } from "../../components/Tabs";
import { legitimacyTone } from "../../lib/legitimacy";
import type { ScanDetail, ScanResult, RunStatus, LegitimacyTier } from "../../../types";

type SortBy = "fit" | "verdict";

const VERDICT_ORDER = ["Apply", "Consider", "Research first", "Skip"] as const;

const VERDICT_TONE: Record<(typeof VERDICT_ORDER)[number], TagTone> = {
  Apply: "good",
  Consider: "warn",
  "Research first": "neutral",
  Skip: "danger",
};

const STATUS_TONE: Record<RunStatus, TagTone> = {
  completed: "good",
  running: "warn",
  queued: "neutral",
  failed: "danger",
};

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export interface ScanReplayProps {
  detail: ScanDetail;
}

export function ScanReplay({ detail }: ScanReplayProps) {
  const [sortBy, setSortBy] = React.useState<SortBy>("fit");
  const { stats, results } = detail;

  const scored = React.useMemo(() => {
    const rows = results.filter((r) => r.outcome === "scored");
    return [...rows].sort((a, b) => {
      if (sortBy === "fit") return (b.fit ?? 0) - (a.fit ?? 0);
      const rank = (r: ScanResult) => VERDICT_ORDER.indexOf((r.verdict ?? "Skip") as (typeof VERDICT_ORDER)[number]);
      return rank(a) - rank(b);
    });
  }, [results, sortBy]);

  const others = results.filter((r) => r.outcome !== "scored");

  const tierCounts = React.useMemo(() => {
    const counts = new Map<LegitimacyTier, number>();
    for (const r of results) {
      if (!r.legitimacyTier) continue;
      counts.set(r.legitimacyTier, (counts.get(r.legitimacyTier) ?? 0) + 1);
    }
    return [...counts.entries()];
  }, [results]);

  const totalDurationMs = stats.discoverMs + stats.scoreMs;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card padding="lg">
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ font: "var(--type-h3)", color: "var(--text-strong)" }}>{detail.resumeName}</span>
          <Tag tone="neutral">{detail.persona}</Tag>
          <Tag tone={STATUS_TONE[detail.status] ?? "neutral"}>{detail.status}</Tag>
          {stats.capStopped && <Tag tone="warn">Partial — daily cap</Tag>}
        </div>
        <div
          style={{
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            marginTop: 10,
            font: "var(--type-body)",
            color: "var(--text-muted)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <span>{new Date(detail.startedAt).toLocaleString()}</span>
          <span>·</span>
          <span>{formatDuration(totalDurationMs)}</span>
          <span>·</span>
          <span>${stats.costUsd.toFixed(2)}</span>
          <span>·</span>
          <span>{stats.policyVersion}</span>
        </div>
        {detail.error && (
          <div style={{ marginTop: 10, font: "var(--type-body)", color: "var(--danger-ink)" }}>{detail.error}</div>
        )}
      </Card>

      <Card padding="lg">
        <div style={{ font: "var(--type-h3)", color: "var(--text-strong)", marginBottom: 10 }}>Discover</div>
        <div style={{ display: "flex", gap: 6, font: "var(--type-body)", color: "var(--text-body)" }}>
          <span>{stats.scanned} scanned</span>
          <span>·</span>
          <span>{stats.matched} matched</span>
          <span>·</span>
          <span>{formatSeconds(stats.discoverMs)}</span>
        </div>
        {(stats.perSource ?? []).length > 0 && (
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
            {(stats.perSource ?? []).map((p) => (
              <div
                key={p.sourceId}
                style={{ display: "flex", gap: 6, font: "var(--type-caption)", color: "var(--text-muted)" }}
              >
                <span>{p.sourceId}</span>
                <span>·</span>
                <span>{p.found} found</span>
                <span>·</span>
                <span>
                  {p.errors} {p.errors === 1 ? "error" : "errors"}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card padding="lg">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ font: "var(--type-h3)", color: "var(--text-strong)" }}>Score</div>
          <Tabs
            tabs={[
              { id: "fit", label: "Fit" },
              { id: "verdict", label: "Verdict" },
            ]}
            activeId={sortBy}
            onSelect={(id) => setSortBy(id as SortBy)}
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {scored.map((r) => (
            <div
              key={r.jobId}
              data-testid="score-row"
              data-fit={r.fit}
              data-job-id={r.jobId}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 0",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <ScoreBadge score={r.fit ?? 0} size="sm" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ font: "var(--type-label)", color: "var(--text-strong)" }}>{r.title}</div>
                <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 2 }}>
                  {r.company} · {r.source}
                </div>
              </div>
              {r.verdict && <Tag tone={VERDICT_TONE[r.verdict]}>{r.verdict}</Tag>}
              {r.scoredMs != null && (
                <span style={{ font: "var(--type-caption)", color: "var(--text-muted)", flexShrink: 0 }}>
                  {formatSeconds(r.scoredMs)}
                </span>
              )}
            </div>
          ))}
        </div>

        {others.length > 0 && (
          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 4 }}>
            {others.map((r) => (
              <div
                key={r.jobId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 0",
                  font: "var(--type-caption)",
                  color: "var(--text-muted)",
                }}
              >
                <Tag tone="neutral">{r.outcome}</Tag>
                <span>
                  {r.title} · {r.company}
                </span>
                {r.outcome === "error" && r.error && <span>— {r.error}</span>}
                {r.outcome === "skipped" && r.reason === "dailyCap" && <span>— daily cap reached</span>}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card padding="lg">
        <div style={{ font: "var(--type-h3)", color: "var(--text-strong)", marginBottom: 10 }}>Legitimacy</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {tierCounts.map(([tier, count]) => (
            <Tag key={tier} tone={legitimacyTone(tier)}>
              {count} {tier}
            </Tag>
          ))}
        </div>
      </Card>
    </div>
  );
}
