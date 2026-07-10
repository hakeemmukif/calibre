"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { Tabs } from "../../components/Tabs";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { Textarea } from "../../components/Textarea";
import type { ApplicationQuestion } from "../../../types";

export type IntakeMode = "detected" | "paste-form" | "paste-jd";

export interface QuestionIntakeProps {
  mode: IntakeMode;
  onModeChange(mode: IntakeMode): void;
  /** A known-ATS form the scan service pre-extracted — intake is skipped for it. */
  detected?: ApplicationQuestion[];
  onExtract(mode: IntakeMode, text?: string): void;
  extracting?: boolean;
  error?: string;
  onManualAdd(): void;
}

// QuestionIntake — the 3-mode Tabs front door for F4 (§2): Detected (a
// known-ATS form arrives pre-extracted, no paste needed), Paste form (raw
// application-form text), Paste JD (no form available — the LLM infers
// likely questions, stamped `jd-inferred` downstream).
export function QuestionIntake({ mode, onModeChange, detected, onExtract, extracting, error, onManualAdd }: QuestionIntakeProps) {
  const [text, setText] = React.useState("");

  return (
    <Card padding="lg">
      <Tabs
        tabs={[
          { id: "detected", label: "Detected" },
          { id: "paste-form", label: "Paste form" },
          { id: "paste-jd", label: "Paste JD" },
        ]}
        activeId={mode}
        onSelect={(id) => onModeChange(id as IntakeMode)}
      />

      <div style={{ marginTop: 16 }}>
        {mode === "detected" && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 4px" }}>
            {detected && detected.length > 0 ? (
              <>
                <Icon name="circle-check" size={18} style={{ color: "var(--fit-strong)" }} />
                <span style={{ font: "var(--type-body)", color: "var(--text-strong)" }}>
                  {detected.length} question{detected.length === 1 ? "" : "s"} detected from the posting's application form.
                </span>
              </>
            ) : (
              <span style={{ font: "var(--type-body)", color: "var(--text-muted)" }}>
                No pre-extracted form for this posting — switch to "Paste form" or "Paste JD".
              </span>
            )}
          </div>
        )}

        {(mode === "paste-form" || mode === "paste-jd") && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                mode === "paste-form"
                  ? "Paste the raw application-form text (question labels, one per line)…"
                  : "Paste the job description — likely questions will be inferred…"
              }
              rows={7}
              disabled={extracting}
            />
            {error && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, font: "var(--type-caption)", color: "var(--danger-ink)" }}>
                <Icon name="triangle-alert" size={13} />
                {error}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              {error && (
                <Button variant="ghost" onClick={onManualAdd}>Add questions manually</Button>
              )}
              <Button
                variant="primary"
                iconLeft={extracting ? undefined : "sparkles"}
                disabled={extracting || text.trim().length < 20}
                onClick={() => onExtract(mode, text)}
              >
                {extracting ? "Extracting…" : error ? "Retry extraction" : "Extract questions"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
