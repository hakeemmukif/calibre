// Run status route — JSON snapshot by default, SSE when `Accept:
// text/event-stream` (api-contract.md §3/§4). Search-only this slice: emits
// `progress`/`done`/`error`, never `job` (B6 adds job scoring/events).
import { NextRequest, NextResponse } from "next/server";
import { get as getRunHandle } from "@/server/runs/registry";
import { searchRunsRepo } from "@/server/persistence/repos/searchRuns";
import { toSearchRun } from "@/server/search/assemble-run";
import type { ErrorEnvelope } from "@/types";

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string, details?: unknown) {
  const body: ErrorEnvelope = { error: { code, message, ...(details !== undefined ? { details } : {}) } };
  return NextResponse.json(body, { status });
}

function sseLine(eventName: string, data: unknown, eventId: number): string {
  return `id: ${eventId}\nevent: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const row = await searchRunsRepo.getById(id);
  if (!row) {
    return errorResponse(404, "NOT_FOUND", `No search run with id "${id}".`);
  }

  const acceptsSse = (request.headers.get("accept") ?? "").includes("text/event-stream");
  if (!acceptsSse) {
    return NextResponse.json(toSearchRun(row), { status: 200 });
  }

  const handle = getRunHandle(id);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // No live handle for this run (process restarted since it was
      // created, or it already completed and was evicted) — synthesize a
      // single terminal event from the persisted row instead of hanging.
      if (!handle || handle.isTerminal) {
        if (row.status === "completed") {
          controller.enqueue(encoder.encode(sseLine("done", toSearchRun(row), 1)));
        } else {
          const envelope: ErrorEnvelope = {
            error: { code: "CONFLICT", message: row.error ?? `Run ${id} is not streamable (status: ${row.status}).` },
          };
          controller.enqueue(encoder.encode(sseLine("error", envelope, 1)));
        }
        controller.close();
        return;
      }

      const unsubscribe = handle.subscribe((event, eventId) => {
        controller.enqueue(encoder.encode(sseLine(event.event, event.data, eventId)));
        if (event.event === "done" || event.event === "error") {
          unsubscribe();
          controller.close();
        }
      });

      request.signal.addEventListener("abort", () => {
        unsubscribe();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
