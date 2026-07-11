// The four-stage scan model the ScanProgress overlay renders, reduced from the
// backend's `progress` SSE events. The stage keys ARE the frozen search
// `Progress.stage` values the run emits (server/search/run.ts:
// sources → fetch → score → legitimacy); the labels are Caliber's display copy
// for them (the design mockup's four rows). Pure, UI-agnostic — the hook and
// the composition both build on it.
import type { Progress } from "@/types";

export const SCAN_STAGES = ["sources", "fetch", "score", "legitimacy"] as const;
export type ScanStage = (typeof SCAN_STAGES)[number];

export const SCAN_STAGE_LABELS: Record<ScanStage, string> = {
  sources: "Discovering postings",
  fetch: "Reading each posting",
  score: "Scoring fit",
  legitimacy: "Filtering ghost jobs",
};

export interface ScanStageState {
  stage: ScanStage;
  label: string;
  state: "pending" | "active" | "done";
  current?: number;
  total?: number;
  detail?: string; // latest live label from the Progress event
}

function isScanStage(stage: string): stage is ScanStage {
  return (SCAN_STAGES as readonly string[]).includes(stage);
}

export function initialStages(): ScanStageState[] {
  return SCAN_STAGES.map((stage) => ({ stage, label: SCAN_STAGE_LABELS[stage], state: "pending" }));
}

// Stages advance in contract order, so a `progress` event for stage N implies
// stages before it are complete. An unrecognized stage (the contract types
// `stage` as a free string, and connectors emit sub-stage labels) leaves the
// model untouched rather than throwing.
export function applyProgress(stages: ScanStageState[], progress: Progress): ScanStageState[] {
  if (!isScanStage(progress.stage)) return stages;
  const activeIndex = SCAN_STAGES.indexOf(progress.stage);
  return stages.map((row, index) => {
    if (index < activeIndex) return { ...row, state: "done" };
    if (index === activeIndex) {
      return { ...row, state: "active", current: progress.current, total: progress.total, detail: progress.label };
    }
    return row;
  });
}

export function completeAllStages(stages: ScanStageState[]): ScanStageState[] {
  return stages.map((row) => ({ ...row, state: "done" }));
}
