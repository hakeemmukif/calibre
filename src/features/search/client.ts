// F2 typed client — kicks off + polls/streams a search run (api-contract.md
// §3 "POST /api/search", "GET /api/search/:id", §4 SSE). Never imports
// server/* or lib/llm.
import { z } from "zod";
import { Persona, ScanDetail, SearchRun, SearchRunSummary, SseEvent } from "@/types";
import { requestJson } from "@/features/http";
import { refreshCredits } from "@/features/credits/creditsStore";
import { track } from "@/features/analytics/client";
import { EVENTS } from "@/features/analytics/events";

export interface StartSearchInput {
  persona: Persona;
  sources?: string[];
}

export async function startSearch(input: StartSearchInput): Promise<SearchRun> {
  const run = await requestJson(
    "/api/search",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
    SearchRun,
  );
  refreshCredits();
  track(EVENTS.scanStarted);
  return run;
}

const ListScansResponse = z.object({ items: SearchRunSummary.array(), nextCursor: z.string().nullable() });
export type ListScansResponse = z.infer<typeof ListScansResponse>;

export async function listScans(opts?: { limit?: number; cursor?: string }): Promise<ListScansResponse> {
  const params = new URLSearchParams();
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts?.cursor !== undefined) params.set("cursor", opts.cursor);
  const qs = params.toString();
  return requestJson(`/api/search${qs ? `?${qs}` : ""}`, undefined, ListScansResponse);
}

export async function getScanDetail(id: string): Promise<ScanDetail> {
  return requestJson(`/api/search/${id}`, undefined, ScanDetail);
}

// `EventSource` sends `Accept: text/event-stream` automatically (browser
// spec) — no manual header needed to hit the route's SSE branch. Each
// `SseEvent` union member is a distinct named SSE event
// (progress|job|done|error); the stream self-closes after done/error.
//
// Transport errors are left to EventSource's native auto-reconnect below the
// cap: the server closes silently with a `retry` hint when a handle isn't
// visible yet (route.ts's no-handle branch for a queued/running row), and
// the browser reconnects on its own for any other drop (proxy reset,
// dev-server recompile). But if the handle NEVER appears, that reconnect
// repeats forever (~every 2s), each one costing the server a DB join +
// session lookup — MAX_CONSECUTIVE_ERRORS bounds it: once errors run that
// deep with no named event in between, give up and report a terminal error
// through the same callback instead of retrying indefinitely.
const MAX_CONSECUTIVE_ERRORS = 30;

export function subscribeSearch(id: string, onEvent: (event: SseEvent) => void): () => void {
  const source = new EventSource(`/api/search/${id}`);
  const eventNames = ["progress", "job", "source", "jobPhase", "snapshot", "done", "error"] as const;

  let consecutiveErrors = 0;

  const handlers = eventNames.map((name) => {
    const handler = (e: MessageEvent<string>) => {
      // A transport error is dispatched to this named "error" listener too
      // (plain Event, no data) — without this guard it would reset the streak
      // below before onerror ever counts it, and the cap could never trip.
      if (typeof e.data !== "string") return;
      consecutiveErrors = 0; // any named event proves the connection is alive — reset the streak
      const event = SseEvent.parse({ event: name, data: JSON.parse(e.data) });
      onEvent(event);
      if (name === "done" || name === "error") source.close();
    };
    source.addEventListener(name, handler);
    return { name, handler };
  });

  source.onerror = () => {
    consecutiveErrors += 1;
    if (consecutiveErrors < MAX_CONSECUTIVE_ERRORS) return; // still below cap — let native auto-reconnect keep trying
    source.close();
    onEvent({ event: "error", data: { error: { code: "INTERNAL", message: "Lost connection to the search run." } } });
  };

  return () => {
    for (const { name, handler } of handlers) source.removeEventListener(name, handler);
    source.close();
  };
}
