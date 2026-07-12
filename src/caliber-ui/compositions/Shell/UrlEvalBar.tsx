"use client";
import * as React from "react";
import { Input } from "../../components/Input";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";

export type UrlEvalStatus = "idle" | "evaluating" | "success" | "error";

export interface UrlEvalBarProps {
  onSubmit(url: string): void;
  status: UrlEvalStatus;
  stageText?: string;
  error?: string;
}

// UrlEvalBar — the header omnibox front door for F2 (paste a URL to eval a
// role). Composes Input (link icon) + Button "Check".
export function UrlEvalBar({ onSubmit, status, stageText, error }: UrlEvalBarProps) {
  const [url, setUrl] = React.useState("");
  const evaluating = status === "evaluating";

  function submit() {
    if (!url.trim() || evaluating) return;
    onSubmit(url.trim());
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%", maxWidth: 480 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Icon name="link" size={16} style={{ color: "var(--text-muted)", flex: "none" }} />
        <Input
          aria-label="Job posting URL"
          placeholder="Paste a job posting URL to check it…"
          value={url}
          disabled={evaluating}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          style={{ flex: 1 }}
        />
        <Button variant="primary" onClick={submit} disabled={evaluating || !url.trim()}>
          {evaluating ? "Checking…" : "Check"}
        </Button>
      </div>
      {status === "evaluating" && stageText && (
        <div style={{ display: "flex", alignItems: "center", gap: 5, font: "var(--type-caption)", color: "var(--text-muted)" }}>
          {stageText}
        </div>
      )}
      {status === "success" && (
        <div style={{ display: "flex", alignItems: "center", gap: 5, font: "var(--type-caption)", color: "var(--success)" }}>
          <Icon name="circle-check" size={13} />
          Checked
        </div>
      )}
      {status === "error" && error && (
        <div role="alert" style={{ display: "flex", alignItems: "center", gap: 5, font: "var(--type-caption)", color: "var(--danger-ink)" }}>
          <Icon name="triangle-alert" size={13} />
          {error}
        </div>
      )}
    </div>
  );
}
