// M2 client hook — subscribes to a run's SSE stream and folds each event
// through the pure `foldScanEvent` reducer into the live concurrency-lane
// frame; tracks a coarse status from the terminal `done`/`error` events.
// Mirrors useScanRun's subscribe lifecycle. features/* only — never imports
// @/server/*.
import { useEffect, useReducer, useState } from "react";
import { subscribeSearch } from "./client";
import { EMPTY_LIVE, foldScanEvent, LiveState } from "./scanLive";

export function useScanLive(runId: string | null): { state: LiveState; status: "idle" | "running" | "done" | "error" } {
  const [state, dispatch] = useReducer(foldScanEvent, EMPTY_LIVE);
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  useEffect(() => {
    if (!runId) return;
    setStatus("running");
    const unsub = subscribeSearch(runId, (event) => {
      dispatch(event);
      if (event.event === "done") setStatus("done");
      if (event.event === "error") setStatus("error");
    });
    return () => unsub();
  }, [runId]);
  return { state, status };
}
