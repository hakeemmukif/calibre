"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { ScoreBadge } from "../../components/ScoreBadge";
import { Tag } from "../../components/Tag";
import { Tabs } from "../../components/Tabs";
import { IconButton } from "../../components/IconButton";
import { Icon } from "../../components/Icon";
import { Button } from "../../components/Button";
import { StagePips } from "./StagePips";
import { agoLabel } from "../../lib/format";
import type { Application } from "../../../types";

// SortSpec isn't defined anywhere in the contract/component-inventory docs —
// only referenced by name in §1's Tracker row. Defined here as the minimal
// additive shape the console needs; not a contract entity.
export type TrackerSortKey = "score" | "appliedAt" | "company";
export interface SortSpec {
  key: TrackerSortKey;
  dir: "asc" | "desc";
}

export interface TrackerTableProps {
  rows: Application[];
  sort: SortSpec;
  onSort(spec: SortSpec): void;
  onOpen(id: string): void;
  onLogUpdate(id: string): void;
  /** Not in the frozen signature; wired so the empty-state CTA has somewhere
   * to go — optional, additive (mirrors JobFeed's onRetry precedent). */
  onGoToFeed?(): void;
  /** Not in the frozen signature; lets a story land directly on the Closed
   * tab instead of requiring a click — optional, additive. */
  initialTab?: "active" | "closed";
}

type Tab = "active" | "closed";

const COLUMNS: { key: TrackerSortKey; label: string }[] = [
  { key: "score", label: "Fit" },
  { key: "company", label: "Role · Company" },
  { key: "appliedAt", label: "Applied" },
];

function compare(a: Application, b: Application, key: TrackerSortKey): number {
  switch (key) {
    case "score":
      return a.score - b.score;
    case "appliedAt":
      return new Date(a.appliedAt).getTime() - new Date(b.appliedAt).getTime();
    case "company":
      return a.company.localeCompare(b.company);
  }
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "10px 16px",
  borderBottom: "1px solid var(--border)",
  font: "var(--type-eyebrow)",
  textTransform: "uppercase",
  letterSpacing: "var(--tracking-caps)",
  color: "var(--text-muted)",
};

// TrackerTable — the F5 console (treatment C): sortable table of Application
// rows — fit ScoreBadge, role/company, StagePips, statusTone Tag, tailored
// flag — split into Active/Closed tabs (`statusTone: 'neutral'` = closed,
// per the contract note on Application.statusTone).
export function TrackerTable({ rows, sort, onSort, onOpen, onLogUpdate, onGoToFeed, initialTab = "active" }: TrackerTableProps) {
  const [tab, setTab] = React.useState<Tab>(initialTab);
  const [focusedRow, setFocusedRow] = React.useState<string | null>(null);

  function handleSort(key: TrackerSortKey) {
    const dir: SortSpec["dir"] = sort.key === key && sort.dir === "desc" ? "asc" : "desc";
    onSort({ key, dir });
  }

  const scoped = rows.filter((r) => (tab === "closed" ? r.statusTone === "neutral" : r.statusTone !== "neutral"));
  const sorted = [...scoped].sort((a, b) => compare(a, b, sort.key) * (sort.dir === "asc" ? 1 : -1));

  const counts = {
    active: rows.filter((r) => r.statusTone !== "neutral").length,
    closed: rows.filter((r) => r.statusTone === "neutral").length,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Tabs
        tabs={[
          { id: "active", label: `Active · ${counts.active}` },
          { id: "closed", label: `Closed · ${counts.closed}` },
        ]}
        activeId={tab}
        onSelect={(id) => setTab(id as Tab)}
      />

      {sorted.length === 0 ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "48px 20px", textAlign: "center" }}>
          <span style={{ font: "var(--type-body)", color: "var(--text-muted)" }}>
            {tab === "closed"
              ? "No closed applications yet."
              : "No applications tracked yet — apply to a job from your feed to start the pipeline."}
          </span>
          {tab === "active" && onGoToFeed && (
            <Button variant="primary" iconRight="arrow-right" onClick={onGoToFeed}>
              Go to feed
            </Button>
          )}
        </div>
      ) : (
        <Card padding="none" style={{ overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {COLUMNS.map((c) => {
                  const on = sort.key === c.key;
                  return (
                    <th key={c.key} style={thStyle}>
                      <button
                        type="button"
                        onClick={() => handleSort(c.key)}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          padding: 0,
                          font: "inherit",
                          color: on ? "var(--text-strong)" : "var(--text-muted)",
                        }}
                      >
                        {c.label}
                        {on && <Icon name={sort.dir === "asc" ? "chevron-up" : "chevron-down"} size={13} />}
                      </button>
                    </th>
                  );
                })}
                <th style={thStyle}>Stage</th>
                <th style={thStyle}>Status</th>
                <th style={{ ...thStyle, width: 48 }} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr
                  key={row.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpen(row.id)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onOpen(row.id);
                    }
                  }}
                  onFocus={() => setFocusedRow(row.id)}
                  onBlur={() => setFocusedRow((f) => (f === row.id ? null : f))}
                  style={{
                    cursor: "pointer",
                    borderBottom: "1px solid var(--border-faint)",
                    outline: focusedRow === row.id ? "2px solid var(--focus-ring)" : "none",
                    outlineOffset: -2,
                  }}
                >
                  <td style={{ padding: "12px 16px" }}>
                    <ScoreBadge score={row.score} size="sm" />
                  </td>
                  <td style={{ padding: "12px 16px", maxWidth: 320 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <span style={{ font: "var(--type-h3)", color: "var(--text-strong)" }}>{row.role}</span>
                      {row.tailored && (
                        <Tag tone="neutral">
                          <Icon name="sparkles" size={11} strokeWidth={2.4} />
                          Tailored
                        </Tag>
                      )}
                    </div>
                    <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 2 }}>
                      {row.company} · {row.meta} · Applied {agoLabel(row.appliedAt)}
                    </div>
                  </td>
                  <td style={{ padding: "12px 16px" }}>
                    <StagePips stage={row.stage} />
                  </td>
                  <td style={{ padding: "12px 16px" }}>
                    <Tag tone={row.statusTone}>{row.statusLabel}</Tag>
                  </td>
                  <td style={{ padding: "12px 16px", textAlign: "right" }}>
                    <IconButton
                      icon="pencil"
                      label="Log update"
                      onClick={(e) => {
                        e.stopPropagation();
                        onLogUpdate(row.id);
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
