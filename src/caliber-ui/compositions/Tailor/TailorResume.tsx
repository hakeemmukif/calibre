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
  /** The generated tailoring result. Optional because Storybook has no live
   * `POST /api/tailor` run to await — additive, seeds the review panel. */
  tailored?: TailoredResume;
  /** Additive: sets which panel renders on mount, since there's no backend
   * driving real state transitions in Storybook (mirrors JobFeed's
   * externally-controlled `loading`/`error`). Defaults from `tailored`. */
  status?: TailorUiState;
  /** Shown in the `error` state. */
  error?: string;
  /** Additive: seeds each diff entry's accept flag, so a story can land
   * directly on "all changes rejected" without a click-through. */
  initialAccepted?: boolean[];
  onGenerate?(): void;
  onExport(): void;
  onSave(t: TailoredResume): void;
}

// TailorResume — F6, diff-review not a split editor (§3): TailorControls →
// ChangeList (grouped by section) + TailorPreview (accepted-only paper
// preview) → ExportBar. States: configuring · generating · review
// (all-rejected is a derived banner inside review, not a separate mode) ·
// generation-error · saved · exporting.
export function TailorResume({ job, resume, tailored, status, error, initialAccepted, onGenerate, onExport, onSave }: TailorResumeProps) {
  const [uiState, setUiState] = React.useState<TailorUiState>(status ?? (tailored ? "review" : "configuring"));
  const [accepted, setAccepted] = React.useState<boolean[]>(
    () => initialAccepted ?? tailored?.diff.map(() => true) ?? [],
  );

  function handleGenerate() {
    setUiState("generating");
    onGenerate?.();
    window.setTimeout(() => {
      if (tailored) {
        setAccepted(tailored.diff.map(() => true));
        setUiState("review");
      } else {
        setUiState("error");
      }
    }, 900);
  }

  function handleToggle(index: number, accept: boolean) {
    setAccepted((prev) => prev.map((a, i) => (i === index ? accept : a)));
  }

  function handleSave() {
    if (!tailored) return;
    onSave(tailored);
    setUiState("saved");
  }

  function handleExport() {
    setUiState("exporting");
    onExport();
    window.setTimeout(() => setUiState("review"), 900);
  }

  const acceptedCount = accepted.filter(Boolean).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <TailorControls job={job} status={uiState === "generating" ? "generating" : "configuring"} onGenerate={handleGenerate} />

      {uiState === "generating" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                height: 96,
                borderRadius: "var(--radius-lg)",
                background: "var(--surface-sunken)",
                animation: "caliber-tailor-pulse 1.1s ease-in-out infinite alternate",
              }}
            />
          ))}
          <style>{`@keyframes caliber-tailor-pulse { from { opacity: .55; } to { opacity: 1; } }`}</style>
        </div>
      )}

      {uiState === "error" && (
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

      {tailored && (uiState === "review" || uiState === "saved" || uiState === "exporting") && (
        <>
          {uiState === "saved" && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, font: "var(--type-body)", color: "var(--fit-strong)" }}>
              <Icon name="circle-check" size={16} />
              Saved a copy of your tailored résumé.
            </div>
          )}

          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
            <div style={{ flex: "1 1 360px", minWidth: 320 }}>
              <ChangeList changes={tailored.diff} accepted={accepted} onToggle={handleToggle} />
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
            exporting={uiState === "exporting"}
            onSave={handleSave}
            onExport={handleExport}
          />
        </>
      )}
    </div>
  );
}
