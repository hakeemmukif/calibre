"use client";
import * as React from "react";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Icon } from "../../components/Icon";
import { PoolFunctionCards } from "./PoolFunctionCards";
import { PoolStrips } from "./PoolStrips";
import type { AdminPoolStats } from "../../../types";

export interface PoolPanelProps {
  stats?: AdminPoolStats;
  loading: boolean;
  error?: string;
  onRetry?(): void;
}

function TileRow({ totals }: { totals: AdminPoolStats["totals"] }) {
  const cells = [
    { label: "Live postings", value: totals.live.toLocaleString() },
    { label: "Delisted", value: totals.delisted.toLocaleString() },
    { label: "New last 24h", value: totals.newLast24h.toLocaleString() },
    { label: "Boards (enabled/total)", value: `${totals.sourcesEnabled}/${totals.sourcesTotal}` },
    { label: "Function-tag coverage", value: `${totals.tagCoveragePct}%` },
  ];
  return (
    <Card padding="none" elevation="none" style={{ background: "var(--surface-sunken)", border: "none", marginBottom: 20 }}>
      <div style={{ display: "flex" }}>
        {cells.map((c, i) => (
          <div key={c.label} style={{ flex: 1, padding: "16px 20px", borderLeft: i > 0 ? "1px solid var(--border)" : "none" }}>
            <div style={{ font: "700 26px/1 var(--font-display)", color: "var(--text-strong)", fontVariantNumeric: "tabular-nums" }}>
              {c.value}
            </div>
            <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 4 }}>{c.label}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// PoolPanel — the Admin Pool tab body (spec 2026-07-21-admin-pool-tab-
// design.md §3): tile row + PoolFunctionCards + PoolStrips. Owns its own
// loading/error/empty/populated states (mirrors JobFeed, not CrawlPanel) —
// this is the composition spec §7's 4 Storybook states are storied against.
export function PoolPanel({ stats, loading, error, onRetry }: PoolPanelProps) {
  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            style={{
              height: 88,
              borderRadius: "var(--radius-lg)",
              background: "var(--surface-sunken)",
              animation: "caliber-pulse 1.1s ease-in-out infinite alternate",
            }}
          />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "40px 20px", textAlign: "center" }}>
        <Icon name="triangle-alert" size={22} style={{ color: "var(--danger-ink)" }} />
        <span style={{ font: "var(--type-body)", color: "var(--text-body)" }}>{error}</span>
        <Button variant="secondary" onClick={onRetry} iconLeft="refresh-cw">
          Retry
        </Button>
      </div>
    );
  }

  if (!stats || stats.totals.live === 0) {
    return (
      <div style={{ padding: "40px 20px", textAlign: "center", font: "var(--type-body)", color: "var(--text-muted)" }}>
        Pool is empty — nothing crawled yet.
      </div>
    );
  }

  return (
    <div>
      <TileRow totals={stats.totals} />
      <PoolFunctionCards mix={stats.functionMix} />
      <div style={{ marginTop: 24 }}>
        <PoolStrips tzBands={stats.tzBands} freshness={stats.freshness} concentration={stats.concentration} />
      </div>
    </div>
  );
}
