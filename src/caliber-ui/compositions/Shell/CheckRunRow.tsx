"use client";
import * as React from "react";
import { Icon } from "../../components/Icon";
import { Button } from "../../components/Button";
import { StageGlyph } from "../Feed/ScanProgress";
import type { CheckRun, CheckRunPhase } from "@/features/url-check/checksStore";

const GLYPH: Record<CheckRunPhase, "pending" | "active" | "done"> = {
  starting: "active", queued: "pending", fetching: "active", scoring: "active",
  done: "done", needsText: "pending", failed: "pending",
};
const LABEL: Record<CheckRunPhase, string> = {
  starting: "Starting…", queued: "Waiting for a slot", fetching: "Reading the posting",
  scoring: "Scoring fit · ghost check running alongside", done: "Scored",
  needsText: "Couldn’t read it automatically", failed: "Check failed",
};

export interface CheckRunRowProps {
  run: CheckRun;
  onOpen?(jobId: string): void;
  onRetry?(key: string): void;
  onPasteText?(key: string): void;
  onDismiss?(key: string): void;
}

export function CheckRunRow({ run, onOpen, onRetry, onPasteText, onDismiss }: CheckRunRowProps) {
  const title = run.origin === "reevaluate" ? "Re-scoring this role" : hostname(run.url);
  const done = run.phase === "done";
  const caption = done && run.alreadyKnown ? "Already in your feed" : LABEL[run.phase];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 4px", minWidth: 0 }}>
      {run.phase === "failed" ? <Icon name="triangle-alert" size={18} style={{ color: "var(--danger-ink)", flexShrink: 0 }} />
        : <StageGlyph state={GLYPH[run.phase]} size={22} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ font: "var(--type-label)", color: "var(--text-strong)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
        <div style={{ font: "var(--type-caption)", color: run.phase === "failed" ? "var(--danger-ink)" : "var(--text-muted)" }}>
          {run.phase === "failed" && run.error ? run.error.message : caption}
        </div>
      </div>
      {done && run.jobId && onOpen && <Button variant="ghost" onClick={() => onOpen(run.jobId!)}>View</Button>}
      {run.phase === "needsText" && onPasteText && <Button variant="secondary" onClick={() => onPasteText(run.key)}>Paste text</Button>}
      {run.phase === "failed" && onRetry && <Button variant="secondary" onClick={() => onRetry(run.key)}>Retry</Button>}
      {(done || run.phase === "failed" || run.phase === "needsText") && onDismiss && (
        <Button variant="ghost" onClick={() => onDismiss(run.key)}>Dismiss</Button>
      )}
    </div>
  );
}

function hostname(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}
