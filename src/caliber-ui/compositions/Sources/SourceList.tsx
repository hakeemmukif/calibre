"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { Tag } from "../../components/Tag";
import { Button } from "../../components/Button";
import type { Source } from "../../../types";

export interface SourceListProps {
  sources: Source[];
  /** Id of the row whose PATCH is in flight — its control is disabled. */
  busyId?: string | null;
  onToggle(id: string, enabled: boolean): void;
}

function SourceRow({ source, busy, onToggle }: { source: Source; busy: boolean; onToggle: (id: string, enabled: boolean) => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px" }}>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          font: "var(--type-label)",
          color: "var(--text-strong)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {source.name}
      </div>
      <Tag tone="neutral">{source.kind === "ats" ? "ATS" : "Board"}</Tag>
      <Button
        variant={source.enabled ? "primary" : "secondary"}
        size="sm"
        aria-pressed={source.enabled}
        aria-label={`Toggle ${source.name}`}
        disabled={busy}
        onClick={() => onToggle(source.id, !source.enabled)}
      >
        {source.enabled ? "Enabled" : "Disabled"}
      </Button>
    </div>
  );
}

function SourceGroup({
  title,
  rows,
  busyId,
  onToggle,
}: {
  title: string;
  rows: Source[];
  busyId?: string | null;
  onToggle: (id: string, enabled: boolean) => void;
}) {
  return (
    <Card padding="md" radius="lg" elevation="sm">
      <div
        style={{
          font: "var(--type-eyebrow)",
          textTransform: "uppercase",
          letterSpacing: "var(--tracking-caps)",
          color: "var(--text-faint)",
          marginBottom: 10,
        }}
      >
        {title}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {rows.map((source) => (
          <SourceRow key={source.id} source={source} busy={busyId === source.id} onToggle={onToggle} />
        ))}
      </div>
    </Card>
  );
}

// SourceList — the Sources management page's per-source enable/disable list
// (component-inventory.md; api-contract.md §3 "GET /api/sources", "PATCH
// /api/sources/:id"). Presentational: grouped into the same two persona
// sections PersonaToggle already labels ("Remote · global" / "Malaysia ·
// local"), a source with persona "both" appears in both. No switch primitive
// exists among the 13 (src/caliber-ui/components/index.ts), so the toggle is
// a Button with `aria-pressed` carrying the enabled state.
export function SourceList({ sources, busyId, onToggle }: SourceListProps) {
  const remote = sources.filter((s) => s.persona === "remote" || s.persona === "both");
  const local = sources.filter((s) => s.persona === "local" || s.persona === "both");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SourceGroup title="Remote · global" rows={remote} busyId={busyId} onToggle={onToggle} />
      <SourceGroup title="Malaysia · local" rows={local} busyId={busyId} onToggle={onToggle} />
    </div>
  );
}
