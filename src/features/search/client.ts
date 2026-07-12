// F2 typed client — kicks off + polls/streams a search run (api-contract.md
// §3 "POST /api/search", "GET /api/search/:id", §4 SSE). Never imports
// server/* or lib/llm.
import { Persona, SearchRun, SseEvent } from "@/types";
import { requestJson } from "@/features/http";

export interface StartSearchInput {
  persona: Persona;
  sources?: string[];
}

export async function startSearch(input: StartSearchInput): Promise<SearchRun> {
  return requestJson(
    "/api/search",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
    SearchRun,
  );
}

export async function getSearchRun(id: string): Promise<SearchRun> {
  return requestJson(`/api/search/${id}`, undefined, SearchRun);
}

// `EventSource` sends `Accept: text/event-stream` automatically (browser
// spec) — no manual header needed to hit the route's SSE branch. Each
// `SseEvent` union member is a distinct named SSE event
// (progress|job|done|error); the stream self-closes after done/error.
//
// Transport errors are left to EventSource's native auto-reconnect (no
// `onerror` handler here): the server closes silently with a `retry` hint
// when a handle isn't visible yet (route.ts's no-handle branch for a
// queued/running row), and the browser reconnects on its own for any other
// drop (proxy reset, dev-server recompile).
export function subscribeSearch(id: string, onEvent: (event: SseEvent) => void): () => void {
  const source = new EventSource(`/api/search/${id}`);
  const eventNames = ["progress", "job", "done", "error"] as const;

  const handlers = eventNames.map((name) => {
    const handler = (e: MessageEvent<string>) => {
      const event = SseEvent.parse({ event: name, data: JSON.parse(e.data) });
      onEvent(event);
      if (name === "done" || name === "error") source.close();
    };
    source.addEventListener(name, handler);
    return { name, handler };
  });

  return () => {
    for (const { name, handler } of handlers) source.removeEventListener(name, handler);
    source.close();
  };
}
