"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { Tag } from "../../components/Tag";
import { Icon } from "../../components/Icon";
import { agoLabel } from "../../lib/format";
import type { SearchRunSummary } from "../../../types";

export interface ScansListProps {
  runs: SearchRunSummary[];
  onOpen(id: string): void;
}

function StatusIndicator({ run }: { run: SearchRunSummary }) {
  if (run.stats.capStopped) return <Tag tone="warn">Partial</Tag>;
  switch (run.status) {
    case "completed":
      return <Tag tone="good">Completed</Tag>;
    case "failed":
      return <Tag tone="danger">Failed</Tag>;
    case "running":
      return <Icon name="refresh-cw" size={14} style={{ color: "var(--accent-ink)", animation: "caliber-spin 1s linear infinite" }} />;
    case "queued":
      return <Tag tone="neutral">Queued</Tag>;
  }
}

// ScansList — the /scans list composition. A Card per run (JobRow's
// clickable-row pattern), each showing the résumé, when it ran + how long it
// took, the verdict mix, and a status tag. Pure presentational: all data via
// props, no fetching.
export function ScansList({ runs, onOpen }: ScansListProps) {
  function handleKeyDown(e: React.KeyboardEvent, id: string) {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(id);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {runs.map((run) => {
        const durationSec = run.finishedAt
          ? Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)
          : undefined;
        return (
          <Card
            key={run.id}
            interactive
            role="button"
            tabIndex={0}
            onClick={() => onOpen(run.id)}
            onKeyDown={(e) => handleKeyDown(e, run.id)}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <span style={{ font: "var(--type-h3)", color: "var(--text-strong)" }}>{run.resumeName}</span>
              <StatusIndicator run={run} />
            </div>
            <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 3 }}>
              {agoLabel(run.startedAt)}
              {durationSec !== undefined ? ` · ${durationSec}s` : ""}
            </div>
            <div style={{ font: "var(--type-body)", color: "var(--text-body)", marginTop: 6 }}>
              {run.stats.worth} worth · {run.stats.ghosts} ghost · {run.stats.scored} scored
            </div>
          </Card>
        );
      })}
    </div>
  );
}
