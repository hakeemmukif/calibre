// F2 client hook — drives a market-scan run: kicks off `startSearch`,
// subscribes to its SSE stream, reduces `progress` events through the
// scanStages reducer, and surfaces streamed jobs + completion via callbacks.
// features/* only — never imports @/server/*.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Job, Persona, SearchRun, SseEvent, TailoredResume } from "@/types";
import { ApiError } from "@/features/http";
import { startSearch, subscribeSearch } from "./client";
import { applyProgress, completeAllStages, initialStages, ScanStageState } from "./scanStages";

export type ScanStatus = "idle" | "starting" | "running" | "done" | "error";

export interface ScanRunState {
  runId: string | null;
  status: ScanStatus;
  stages: ScanStageState[];
  stats?: { scanned: number; worth: number; ghosts: number };
  error?: string;
}

export interface UseScanRunOptions {
  onJob?(job: Job): void;
  onDone?(run: SearchRun): void;
}

export interface UseScanRun {
  state: ScanRunState;
  start(persona: Persona): Promise<void>;
  subscribeTo(runId: string): void;
  reset(): void;
}

function initialState(): ScanRunState {
  return { runId: null, status: "idle", stages: initialStages() };
}

// `done.data` is `SearchRun | TailoredResume` — only a SearchRun carries `stats`.
function isSearchRun(data: SearchRun | TailoredResume): data is SearchRun {
  return "stats" in data;
}

export function useScanRun(options?: UseScanRunOptions): UseScanRun {
  const [state, setState] = useState<ScanRunState>(initialState());
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const subscribeTo = useCallback((runId: string) => {
    unsubscribeRef.current?.();
    setState({ runId, status: "running", stages: initialStages(), error: undefined, stats: undefined });

    const onEvent = (event: SseEvent) => {
      switch (event.event) {
        case "progress":
          setState((prev) => ({ ...prev, stages: applyProgress(prev.stages, event.data) }));
          break;
        case "job":
          optionsRef.current?.onJob?.(event.data);
          break;
        case "done": {
          const data = event.data;
          if (!isSearchRun(data)) break;
          setState((prev) => ({ ...prev, stages: completeAllStages(prev.stages), status: "done", stats: data.stats }));
          optionsRef.current?.onDone?.(data);
          break;
        }
        case "error":
          setState((prev) => ({ ...prev, status: "error", error: event.data.error.message }));
          break;
      }
    };

    unsubscribeRef.current = subscribeSearch(runId, onEvent);
  }, []);

  const start = useCallback(
    async (persona: Persona) => {
      setState((prev) => ({ ...prev, status: "starting" }));
      try {
        const run = await startSearch({ persona });
        subscribeTo(run.id);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409 && err.code === "CONFLICT") {
          const activeRunId =
            typeof err.details === "object" && err.details !== null && "activeRunId" in err.details
              ? (err.details as { activeRunId: unknown }).activeRunId
              : undefined;
          if (typeof activeRunId === "string") {
            subscribeTo(activeRunId);
            return;
          }
          setState((prev) => ({ ...prev, status: "error", error: err.message }));
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        setState((prev) => ({ ...prev, status: "error", error: message }));
      }
    },
    [subscribeTo],
  );

  const reset = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    setState(initialState());
  }, []);

  useEffect(() => {
    return () => unsubscribeRef.current?.();
  }, []);

  return { state, start, subscribeTo, reset };
}
