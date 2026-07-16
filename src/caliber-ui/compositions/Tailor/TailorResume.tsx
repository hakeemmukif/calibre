"use client";
import * as React from "react";
import { Icon } from "../../components/Icon";
import { Button } from "../../components/Button";
import { TailorControls } from "./TailorControls";
import { TailorReport } from "./TailorReport";
import { ChangeList } from "./ChangeList";
import { TailorPreview } from "./TailorPreview";
import { ExportBar } from "./ExportBar";
import type { Job, Resume, TailoredResume, CorrelationReport } from "../../../types";

export type TailorUiState =
  | "configuring"
  | "correlating"
  | "report"
  | "rewriting"
  | "review"
  | "error"
  | "saved"
  | "exporting"
  | "needs-score";

export interface TailorResumeProps {
  job: Job;
  resume: Resume;
  /** The generated tailoring result — absent until a `POST /api/tailor` run
   * completes. */
  tailored?: TailoredResume;
  /** The measure-step correlation report — absent until a
   * `POST /api/tailor/correlate` run completes. */
  report?: CorrelationReport;
  /** Fully controlled: which panel renders. The parent owns the state
   * machine (mirrors JobFeed's externally-controlled `loading`/`error`) —
   * this component holds no UI-phase state of its own. */
  status: TailorUiState;
  /** Shown in the `error` state. */
  error?: string;
  /** Shown in the `needs-score` state. */
  needsScoreMessage?: string;
  /** Fully controlled: one accept flag per `tailored.diff` entry, by index. */
  accepted: boolean[];
  onToggle(index: number, accept: boolean): void;
  onAnalyze(): void;
  onRewrite(): void;
  onSave(tailoredId: string, acceptedIndices: number[]): void;
  onExport(acceptedIndices: number[]): void;
  onScoreJob?(): void;
}

// TailorResume — F6 phase 2, measure → rewrite (§3): TailorControls →
// TailorReport (measure step) → ChangeList (grouped by section) +
// TailorPreview (accepted-only paper preview) → ExportBar. States:
// configuring · correlating · report · rewriting · review (all-rejected is a
// derived banner inside review, not a separate mode) · error · saved ·
// exporting · needs-score. Purely presentational — every transition
// (`onAnalyze`/`onRewrite`/`onToggle`/`onSave`/`onExport`) is a prop call;
// simulating the backend run lives only in the stories.
export function TailorResume({
  job,
  resume,
  tailored,
  report,
  status,
  error,
  needsScoreMessage,
  accepted,
  onToggle,
  onAnalyze,
  onRewrite,
  onSave,
  onExport,
  onScoreJob,
}: TailorResumeProps) {
  const acceptedIndices = accepted.reduce<number[]>((acc, a, i) => (a ? [...acc, i] : acc), []);
  const acceptedCount = acceptedIndices.length;

  function handleSave() {
    if (!tailored) return;
    onSave(tailored.id, acceptedIndices);
  }

  function handleExport() {
    onExport(acceptedIndices);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <TailorControls job={job} status={status === "correlating" ? "analyzing" : "configuring"} onAnalyze={onAnalyze} />

      {(status === "correlating" || status === "rewriting") && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                height: 96,
                borderRadius: "var(--radius-lg)",
                background: "var(--surface-sunken)",
                animation: "caliber-pulse 1.1s ease-in-out infinite alternate",
              }}
            />
          ))}
        </div>
      )}

      {status === "report" && report && <TailorReport report={report} rewriting={false} onRewrite={onRewrite} />}

      {status === "error" && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 10,
            padding: "40px 20px",
            textAlign: "center",
          }}
        >
          <Icon name="triangle-alert" size={22} style={{ color: "var(--danger-ink)" }} />
          <span style={{ font: "var(--type-body)", color: "var(--text-body)" }}>
            {error ?? "Tailoring failed — try again."}
          </span>
        </div>
      )}

      {status === "needs-score" && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 10,
            padding: "40px 20px",
            textAlign: "center",
          }}
        >
          <Icon name="triangle-alert" size={22} style={{ color: "var(--danger-ink)" }} />
          <span style={{ font: "var(--type-body)", color: "var(--text-body)" }}>
            {needsScoreMessage ?? "Score this job before tailoring."}
          </span>
          <Button variant="soft-accent" onClick={() => onScoreJob?.()}>
            Score this job
          </Button>
        </div>
      )}

      {tailored && (status === "review" || status === "saved" || status === "exporting") && (
        <>
          {status === "saved" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, font: "var(--type-body)", color: "var(--fit-strong)" }}>
                <Icon name="circle-check" size={16} />
                Saved a copy of your tailored résumé.
              </div>
              {tailored?.atsDelta && (
                <div style={{ display: "inline-flex", alignItems: "center", gap: 8, font: "var(--type-body)", color: "var(--verified)" }}>
                  ATS keywords <strong>{tailored.atsDelta.before} → {tailored.atsDelta.after}</strong> of {tailored.atsDelta.total}
                </div>
              )}
            </div>
          )}

          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
            <div style={{ flex: "1 1 360px", minWidth: 320 }}>
              <ChangeList changes={tailored.diff} accepted={accepted} onToggle={onToggle} />
            </div>
            {tailored.resume && (
              <div style={{ flex: "1 1 360px", minWidth: 320 }}>
                <TailorPreview resume={resume} tailoredResume={tailored.resume} diff={tailored.diff} accepted={accepted} />
              </div>
            )}
          </div>

          <ExportBar
            acceptedCount={acceptedCount}
            totalCount={tailored.diff.length}
            exporting={status === "exporting"}
            onSave={handleSave}
            onExport={handleExport}
          />
        </>
      )}
    </div>
  );
}
