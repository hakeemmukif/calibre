// M2 live-frame reducer — folds the enriched SSE stream (`snapshot`/`source`/
// `jobPhase`/`progress`) into the concurrency-lane view state. Pure and
// idempotent: every case sets ABSOLUTE state, so duplicate or out-of-order
// deltas converge. features/* only — never imports @/server/*.
import type { SseEvent, SourceEventData, JobPhaseData } from "@/types";

export type LiveJob = JobPhaseData & { slot: number };
export interface LiveState {
  sources: SourceEventData[];
  activeJobs: LiveJob[];
  counts: { scored: number; queued: number; total: number };
}
export const EMPTY_LIVE: LiveState = { sources: [], activeJobs: [], counts: { scored: 0, queued: 0, total: 0 } };

function lowestFreeSlot(jobs: LiveJob[]): number {
  const taken = new Set(jobs.map((j) => j.slot));
  let s = 0;
  while (taken.has(s)) s++;
  return s;
}

export function foldScanEvent(prev: LiveState, event: SseEvent): LiveState {
  switch (event.event) {
    case "snapshot": {
      // Absolute hydrate; assign slots in array order (stable for a given frame).
      const activeJobs = event.data.activeJobs.map((j, i) => ({ ...j, slot: i }));
      return { sources: event.data.sources, activeJobs, counts: event.data.counts };
    }
    case "source": {
      const sources = prev.sources.some((s) => s.sourceId === event.data.sourceId)
        ? prev.sources.map((s) => (s.sourceId === event.data.sourceId ? event.data : s))
        : [...prev.sources, event.data];
      return { ...prev, sources };
    }
    case "jobPhase": {
      const d = event.data;
      if (d.phase === "done" || d.phase === "error") {
        return { ...prev, activeJobs: prev.activeJobs.filter((j) => j.jobId !== d.jobId) };
      }
      const existing = prev.activeJobs.find((j) => j.jobId === d.jobId);
      const slot = existing ? existing.slot : lowestFreeSlot(prev.activeJobs);
      const activeJobs = existing
        ? prev.activeJobs.map((j) => (j.jobId === d.jobId ? { ...d, slot } : j))
        : [...prev.activeJobs, { ...d, slot }];
      return { ...prev, activeJobs };
    }
    case "progress": {
      // B5: counts come from the existing (idempotent, state-setting) score
      // progress deltas — a snapshot only arrives if the client subscribed after
      // the first frame, which the normal Feed→/scans/:id flow does NOT. The
      // `score` stage's {current,total} are absolute, so this stays idempotent.
      if (event.data.stage !== "score") return prev;
      const total = event.data.total;
      const scored = event.data.current;
      return { ...prev, counts: { scored, total, queued: Math.max(0, total - scored) } };
    }
    default:
      return prev; // job/done/error don't affect the live frame
  }
}
