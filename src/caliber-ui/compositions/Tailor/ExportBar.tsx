"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { Button } from "../../components/Button";

export interface ExportBarProps {
  acceptedCount: number;
  totalCount: number;
  exporting: boolean;
  onSave(): void;
  onExport(): void;
}

// ExportBar — the F6 footer (§3): accepted count · Save copy · Export PDF.
// All-rejected doesn't block export — it just means the exported PDF is the
// unmodified original, called out inline rather than disabling the action.
export function ExportBar({ acceptedCount, totalCount, exporting, onSave, onExport }: ExportBarProps) {
  return (
    <Card padding="sm" elevation="none" style={{ background: "var(--surface-sunken)", border: "none" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <span style={{ font: "var(--type-body)", color: "var(--text-body)" }}>
          {acceptedCount === 0
            ? "All changes rejected — exporting keeps your original résumé."
            : `${acceptedCount} of ${totalCount} changes accepted`}
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="secondary" iconLeft="file-text" onClick={onSave}>
            Save copy
          </Button>
          <Button variant="primary" iconLeft={exporting ? "refresh-cw" : "download"} onClick={onExport} disabled={exporting}>
            {exporting ? "Exporting…" : "Export PDF"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
