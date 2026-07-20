// F6 typed client — start/poll/stream tailoring + finalize/pdf
// (api-contract.md §3 "POST /api/tailor", "GET /api/tailor/:id",
// "POST /api/tailor/:id/finalize", "GET /api/tailor/:id/pdf"). Never imports
// server/* or lib/llm.
import { CorrelationReport, SseEvent, TailoredResume } from "@/types";
import { requestJson } from "@/features/http";
import { refreshCredits } from "@/features/credits/creditsStore";
import { track } from "@/features/analytics/client";
import { EVENTS } from "@/features/analytics/events";

export async function startTailor(input: { jobId: string; reportId?: string }): Promise<TailoredResume> {
  const tailored = await requestJson(
    "/api/tailor",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
    TailoredResume,
  );
  refreshCredits();
  track(EVENTS.tailorStarted);
  return tailored;
}

export async function getTailor(id: string): Promise<TailoredResume> {
  return requestJson(`/api/tailor/${id}`, undefined, TailoredResume);
}

export async function startCorrelate(input: { jobId: string }): Promise<CorrelationReport> {
  const report = await requestJson(
    "/api/tailor/correlate",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
    CorrelationReport,
  );
  refreshCredits();
  return report;
}

export async function getCorrelate(id: string): Promise<CorrelationReport> {
  return requestJson(`/api/tailor/correlate/${id}`, undefined, CorrelationReport);
}

// Same content-negotiated SSE pattern as features/search/client.ts.
export function subscribeTailor(id: string, onEvent: (event: SseEvent) => void): () => void {
  const source = new EventSource(`/api/tailor/${id}`);
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

export async function finalizeTailor(id: string, acceptedIndices: number[]): Promise<TailoredResume> {
  return requestJson(
    `/api/tailor/${id}/finalize`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ acceptedIndices }) },
    TailoredResume,
  );
}

// The PDF route returns a binary body — this is just the href the UI opens
// in a new tab/window, not a fetch+parse wrapper.
export function tailorPdfUrl(id: string): string {
  return `/api/tailor/${id}/pdf`;
}
