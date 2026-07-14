// Tailor run status route — JSON snapshot by default, SSE when `Accept:
// text/event-stream` (api-contract.md §3/§4). Mirrors
// src/app/api/search/[id]/route.ts exactly; tailor never emits a `job` event
// (search-only per the SseEvent comment in src/types).
import { NextRequest, NextResponse } from "next/server";
import { isUuid } from "@/server/http/params";
import { get as getRunHandle } from "@/server/runs/registry";
import { UnauthorizedError } from "@/server/auth/errors";
import { requireUser } from "@/server/auth/session";
import { tailoredResumesRepo } from "@/server/persistence/repos/tailoredResumes";
import { toTailoredResume } from "@/server/tailor/assemble";
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
  if (!isUuid(id)) {
    return errorResponse(404, "NOT_FOUND", `No tailor run with id "${id}".`);
  }

  let session;
  try {
    session = await requireUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    throw err;
  }

  // SSE ownership (Fable design review) — same treatment as
  // src/app/api/search/[id]/route.ts: scoped getById gates BEFORE the
  // in-memory run handle is ever touched.
  const row = await tailoredResumesRepo.getById(id, session.id);
  if (!row) {
    return errorResponse(404, "NOT_FOUND", `No tailor run with id "${id}".`);
  }

  const acceptsSse = (request.headers.get("accept") ?? "").includes("text/event-stream");
  if (!acceptsSse) {
    return NextResponse.json(await toTailoredResume(row), { status: 200 });
  }

  const handle = getRunHandle(id);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        controller.close();
      };

      if (!handle || handle.isTerminal) {
        if (row.status === "completed" || row.status === "failed") {
          const eventName = row.status === "completed" ? "done" : "error";
          const data =
            row.status === "completed"
              ? await toTailoredResume(row)
              : ({ error: { code: "INTERNAL", message: `Tailor run ${id} failed.` } } satisfies ErrorEnvelope);
          controller.enqueue(encoder.encode(sseLine(eventName, data, 1)));
        } else {
          // Row is `queued`/`running` but no handle exists yet — transient
          // only (see src/app/api/search/[id]/route.ts's identical branch
          // for the full rationale). Send a retry hint and close silently;
          // EventSource auto-reconnects.
          controller.enqueue(encoder.encode("retry: 2000\n: no live handle yet\n\n"));
        }
        close();
        return;
      }

      const unsubscribe = handle.subscribe((event, eventId) => {
        if (closed) return;
        controller.enqueue(encoder.encode(sseLine(event.event, event.data, eventId)));
        if (event.event === "done" || event.event === "error") {
          unsubscribe();
          close();
        }
      });

      request.signal.addEventListener("abort", () => {
        unsubscribe();
        close();
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
