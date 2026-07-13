"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";

export interface ScanProgressStageRow {
  stage: string;
  label: string;
  state: "pending" | "active" | "done";
  current?: number;
  total?: number;
  detail?: string;
}

export interface ScanProgressProps {
  status: "running" | "done" | "error";
  stages: ScanProgressStageRow[];
  stats?: { scanned: number; worth: number; ghosts: number };
  error?: string;
  onClose?(): void;
}

export function StageGlyph({ state, size = 26 }: { state: ScanProgressStageRow["state"]; size?: number }) {
  if (state === "done") {
    return (
      <div style={{ width: size, height: size, borderRadius: "50%", background: "var(--fit-strong-soft)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Icon name="check" size={14} style={{ color: "var(--fit-strong)" }} />
      </div>
    );
  }
  if (state === "active") {
    return (
      <div style={{ width: size, height: size, borderRadius: "50%", background: "var(--accent-soft)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Icon name="refresh-cw" size={14} style={{ color: "var(--accent-ink)", animation: "caliber-spin 1s linear infinite" }} />
      </div>
    );
  }
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", border: "1px solid var(--border)", flexShrink: 0 }} />
  );
}

// ScanProgress — the scan-progress overlay shown over the job feed while a
// full market re-scan runs. Pure presentational Card: header + overall
// progress bar (done-stage ratio) + per-stage rows, then an honest
// stats summary (done) or a danger block (error). No numbers are invented —
// everything renders straight from `stages`/`stats`/`error`.
export function ScanProgress({ status, stages, stats, error, onClose }: ScanProgressProps) {
  const doneCount = stages.filter((s) => s.state === "done").length;
  const pct = stages.length > 0 ? (doneCount / stages.length) * 100 : 0;

  return (
    <Card padding="lg" radius="lg" elevation="lg" style={{ maxWidth: 440 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <div style={{ width: 40, height: 40, borderRadius: "50%", background: "var(--accent-soft)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Icon name="search" size={19} style={{ color: "var(--accent-ink)" }} />
        </div>
        <div>
          <div style={{ font: "var(--type-h3)", color: "var(--text-strong)" }}>Scanning the market for you</div>
          <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 2 }}>
            This is a full re-scan, not a refresh — give it a moment while we read and score everything.
          </div>
        </div>
      </div>

      <div style={{ height: 6, borderRadius: "var(--radius-bar)", background: "var(--surface-sunken)", overflow: "hidden", marginBottom: 18 }}>
        <div style={{ height: "100%", width: `${pct}%`, background: "var(--gradient-score)", transition: "width var(--transition)" }} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {stages.map((row) => {
          const boxed = row.state === "active";
          const count = row.current != null && row.total != null ? `${row.current}/${row.total}` : undefined;
          return (
            <div
              key={row.stage}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
                borderRadius: "var(--radius-sm)",
                border: `1px solid ${boxed ? "var(--border-strong)" : "transparent"}`,
                background: boxed ? "var(--surface)" : "transparent",
              }}
            >
              <StageGlyph state={row.state} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ font: "var(--type-label)", color: "var(--text-strong)" }}>{row.label}</div>
                {row.state === "active" && row.detail && (
                  <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 2 }}>{row.detail}</div>
                )}
              </div>
              {count && (
                <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                  {count}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {status === "running" && onClose && (
        <Button variant="ghost" fullWidth onClick={onClose} style={{ marginTop: 14 }}>
          Continue in background
        </Button>
      )}

      {status === "done" && stats && (
        <>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 18, font: "var(--type-body)", color: "var(--text-body)", fontVariantNumeric: "tabular-nums" }}>
            <span>{stats.scanned} scanned</span>
            <span>·</span>
            <span>{stats.worth} worth your time</span>
            <span>·</span>
            <span style={{ color: "var(--accent-ink)" }}>{stats.ghosts} flagged ghost</span>
          </div>
          {onClose && (
            <Button variant="primary" fullWidth onClick={onClose} style={{ marginTop: 14 }}>
              View your matches
            </Button>
          )}
        </>
      )}

      {status === "error" && error && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 18,
            padding: "10px 14px",
            borderRadius: "var(--radius-sm)",
            background: "var(--danger-soft)",
            color: "var(--danger-ink)",
          }}
        >
          <Icon name="triangle-alert" size={16} />
          <span style={{ font: "var(--type-body)" }}>{error}</span>
        </div>
      )}
      {status === "error" && onClose && (
        <Button variant="secondary" fullWidth onClick={onClose} style={{ marginTop: 10 }}>
          Dismiss
        </Button>
      )}
    </Card>
  );
}
