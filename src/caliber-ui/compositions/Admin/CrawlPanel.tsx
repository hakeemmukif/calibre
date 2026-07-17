"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { Icon } from "../../components/Icon";
import { Tag, type TagTone } from "../../components/Tag";
import type { AdminCrawlStatus } from "../../../types";

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "10px 16px",
  borderBottom: "1px solid var(--border)",
  font: "var(--type-eyebrow)",
  textTransform: "uppercase",
  letterSpacing: "var(--tracking-caps)",
  color: "var(--text-muted)",
};

const tdStyle: React.CSSProperties = { padding: "12px 16px" };

function stalenessTone(hours: number | null): TagTone {
  if (hours === null || hours > 48) return "danger";
  if (hours > 24) return "warn";
  return "good";
}

function stalenessLabel(hours: number | null): string {
  if (hours === null) return "never crawled";
  if (hours < 1) return "<1h ago";
  return `${Math.round(hours)}h ago`;
}

export function formatElapsed(startedAtIso: string): string {
  const ms = Math.max(0, Date.now() - new Date(startedAtIso).getTime());
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

// CrawlPanel — read-only Crawl status panel (spec 2026-07-17: the operator's
// live view of the global postings pool). Every section
// (pool/staleness/runningCrawl/lastRuns/perSource) can independently be null
// (the route degrades per-section rather than 500ing) — each block below
// renders its own "unavailable" fallback instead of assuming the whole
// response is well-formed.
export function CrawlPanel({ data }: { data: AdminCrawlStatus }) {
  const { pool, staleness, runningCrawl, lastRuns, perSource } = data;
  return (
    <div style={{ marginTop: 32 }}>
      <div style={{ font: "var(--type-h3)", color: "var(--text-strong)", marginBottom: 12 }}>Crawl</div>

      <div style={{ display: "flex", gap: 12, marginBottom: 16, alignItems: "stretch" }}>
        <Card padding="sm" style={{ flex: 1 }}>
          <div style={{ font: "var(--type-eyebrow)", color: "var(--text-muted)" }}>Live pool</div>
          <div style={{ font: "700 28px/1.2 var(--font-display)", color: "var(--text-strong)" }}>
            {pool ? pool.live.toLocaleString() : "—"}
          </div>
          {pool && (
            <div style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>
              {pool.delisted.toLocaleString()} delisted · {pool.total.toLocaleString()} total
            </div>
          )}
        </Card>
        <Card padding="sm" style={{ flex: 1 }}>
          <div style={{ font: "var(--type-eyebrow)", color: "var(--text-muted)", marginBottom: 6 }}>Staleness</div>
          <Tag tone={stalenessTone(staleness)}>{stalenessLabel(staleness)}</Tag>
        </Card>
      </div>

      {runningCrawl && (
        <Card padding="sm" style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 20 }}>
          <Icon name="activity" size={18} />
          <div style={{ font: "var(--type-body)", color: "var(--text-strong)" }}>
            Crawl running — {runningCrawl.postingsSeenThisRun.toLocaleString()} postings seen · sources written{" "}
            {runningCrawl.sourcesWrittenThisRun}/{perSource?.totalSources ?? "?"} · elapsed {formatElapsed(runningCrawl.startedAt)}
          </div>
        </Card>
      )}

      <div style={{ font: "var(--type-h3)", color: "var(--text-strong)", marginBottom: 8, marginTop: 24 }}>
        Last runs
      </div>
      {!lastRuns ? (
        <div style={{ padding: "16px 4px", font: "var(--type-body)", color: "var(--text-muted)" }}>Unavailable.</div>
      ) : lastRuns.length === 0 ? (
        <div style={{ padding: "16px 4px", font: "var(--type-body)", color: "var(--text-muted)" }}>No completed crawl runs yet.</div>
      ) : (
        <>
          <Card padding="none" style={{ overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={thStyle}>Finished</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Duration</th>
                  <th style={thStyle}>Ok / Failed</th>
                  <th style={thStyle}>Skipped</th>
                  <th style={thStyle}>Upserts</th>
                  <th style={thStyle}>Delists</th>
                  <th style={thStyle}>Empty fetches</th>
                </tr>
              </thead>
              <tbody>
                {lastRuns.map((run) => (
                  <tr key={`${run.startedAt}-${run.finishedAt}`} style={{ borderBottom: "1px solid var(--border-faint)" }}>
                    <td style={{ ...tdStyle, font: "var(--type-body)", color: "var(--text-strong)" }}>
                      {new Date(run.finishedAt).toLocaleString()}
                    </td>
                    <td style={tdStyle}>
                      <Tag tone={run.status === "completed" ? "good" : "danger"}>{run.status}</Tag>
                    </td>
                    <td style={tdStyle}>{formatDuration(run.durationMs)}</td>
                    <td style={tdStyle}>
                      {run.sourcesOk} / {run.sourcesFailed}
                    </td>
                    <td style={{ ...tdStyle, color: run.skipped !== 0 ? "var(--danger-ink)" : undefined, fontWeight: run.skipped !== 0 ? 700 : undefined }}>
                      {run.skipped}
                    </td>
                    <td style={tdStyle}>{run.upserts}</td>
                    <td style={tdStyle}>{run.delists}</td>
                    <td style={{ ...tdStyle, font: "var(--type-caption)", color: "var(--text-muted)" }}>
                      {run.emptyFetches.length > 0 ? run.emptyFetches.join(", ") : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 8 }}>
            upserts = churn, not growth — growth is the night-over-night live-count delta
          </div>
        </>
      )}

      <div style={{ font: "var(--type-h3)", color: "var(--text-strong)", marginBottom: 8, marginTop: 24 }}>
        Sources with the fewest live postings
      </div>
      {!perSource ? (
        <div style={{ padding: "16px 4px", font: "var(--type-body)", color: "var(--text-muted)" }}>Unavailable.</div>
      ) : (
        <Card padding="none" style={{ overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={thStyle}>Source</th>
                <th style={thStyle}>Live postings</th>
                <th style={thStyle}>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {perSource.items.map((row) => (
                <tr key={row.sourceId} style={{ borderBottom: "1px solid var(--border-faint)" }}>
                  <td style={{ ...tdStyle, font: "var(--type-body)", color: "var(--text-strong)" }}>
                    {row.name}
                    <div style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>{row.sourceId}</div>
                  </td>
                  <td style={tdStyle}>{row.liveCount}</td>
                  <td style={tdStyle}>{row.lastSeenAt ? new Date(row.lastSeenAt).toLocaleDateString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
