"use client";
import * as React from "react";
import { Icon } from "../../components/Icon";
import { TailorControls } from "./TailorControls";
import { ChangeList } from "./ChangeList";
import { TailorPreview } from "./TailorPreview";
import { ExportBar } from "./ExportBar";
import type { Job, Resume, TailoredResume } from "../../../types";

export type TailorUiState = "configuring" | "generating" | "review" | "error" | "saved" | "exporting";

export interface TailorResumeProps {
  job: Job;
  resume: Resume;
  /** The generated tailoring result — absent until a `POST /api/tailor` run
   * completes. */
  tailored?: TailoredResume;
  /** Fully controlled: which panel renders. The parent owns the state
   * machine (mirrors JobFeed's externally-controlled `loading`/`error`) —
   * this component holds no UI-phase state of its own. */
  status: TailorUiState;
  /** Shown in the `error` state. */
  error?: string;
  /** Fully controlled: one accept flag per `tailored.diff` entry, by index. */
  accepted: boolean[];
  onToggle(index: number, accept: boolean): void;
  onGenerate(): void;
  onSave(tailoredId: string, acceptedIndices: number[]): void;
  onExport(acceptedIndices: number[]): void;
}

// TailorResume — F6, diff-review not a split editor (§3): TailorControls →
// ChangeList (grouped by section) + TailorPreview (accepted-only paper
// preview) → ExportBar. States: configuring · generating · review
// (all-rejected is a derived banner inside review, not a separate mode) ·
// generation-error · saved · exporting. Purely presentational — every
// transition (`onGenerate`/`onToggle`/`onSave`/`onExport`) is a prop call;
// simulating the backend run lives only in the stories.
export function TailorResume({ job, resume, tailored, status, error, accepted, onToggle, onGenerate, onSave, onExport }: TailorResumeProps) {
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
      <TailorControls job={job} status={status === "generating" ? "generating" : "configuring"} onGenerate={onGenerate} />

      {status === "generating" && (
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
            {error ?? "Tailoring failed — try generating again."}
          </span>
        </div>
      )}

      {tailored && (status === "review" || status === "saved" || status === "exporting") && (
        <>
          {status === "saved" && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, font: "var(--type-body)", color: "var(--fit-strong)" }}>
              <Icon name="circle-check" size={16} />
              Saved a copy of your tailored résumé.
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
