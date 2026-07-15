// Run status route — JSON snapshot by default, SSE when `Accept:
// text/event-stream` (api-contract.md §3/§4). Emits `progress`/`job`/`done`/
// `error` (`job` is B6's scored `Job` streamed as found — server/search/run.ts).
import { NextRequest, NextResponse } from "next/server";
import { get as getRunHandle } from "@/server/runs/registry";
import { isUuid } from "@/server/http/params";
import { UnauthorizedError } from "@/server/auth/errors";
import { requireUser } from "@/server/auth/session";
import { searchRunsRepo } from "@/server/persistence/repos/searchRuns";
import { toSearchRun } from "@/server/search/assemble-run";
import { toScanDetail } from "@/server/search/assemble-summary";
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
    return errorResponse(404, "NOT_FOUND", `No search run with id "${id}".`);
  }

  let session;
  try {
    session = await requireUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    throw err;
  }

  // SSE ownership (Fable design review): resolve the row via the scoped
  // getById BEFORE ever touching the in-memory run handle — EventSource
  // can't send headers, so the cookie session requireUser() just read is the
  // only auth. A foreign run id 404s here, same as an unknown one — the
  // RunHandle itself carries no owner field; the DB row's user_id is the gate.
  const row = await searchRunsRepo.getDetail(id, session.id);
  if (!row) {
    return errorResponse(404, "NOT_FOUND", `No search run with id "${id}".`);
  }

  const acceptsSse = (request.headers.get("accept") ?? "").includes("text/event-stream");
  if (!acceptsSse) {
    return NextResponse.json(toScanDetail(row), { status: 200 });
  }

  const handle = getRunHandle(id);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Guards against a double `controller.close()` (which throws): the
      // terminal-event path and the abort-listener path can both fire —
      // e.g. the client disconnects just after `done`/`error` already closed
      // the stream — so both close and the subscribe callback's enqueue
      // must no-op once either one has run.
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        controller.close();
      };

      // No live handle for this run (process restarted since it was
      // created, or it already completed and was evicted) — synthesize a
      // single terminal event from the persisted row instead of hanging.
      if (!handle || handle.isTerminal) {
        if (row.status === "completed") {
          controller.enqueue(encoder.encode(sseLine("done", toSearchRun(row), 1)));
        } else if (row.status === "failed") {
          const envelope: ErrorEnvelope = {
            error: { code: "INTERNAL", message: row.error ?? `Search run ${id} failed.` },
          };
          controller.enqueue(encoder.encode(sseLine("error", envelope, 1)));
        } else {
          // Row is `queued`/`running` but no handle exists yet — this is
          // only ever transient: either a `next dev` route-bundle race
          // (fixed at the source by registry.ts's globalThis singleton,
          // but a belt-and-suspenders case costs nothing here) or a request
          // that raced the handle's own registration. It is never terminal:
          // a truly orphaned row (process restart) is flipped to `failed`
          // on boot (searchRunsRepo.markAllUnfinishedAsFailed), so any
          // queued/running row here is guaranteed to resolve. Send a retry
          // hint and close silently — EventSource auto-reconnects and the
          // next attempt finds the handle (or the now-terminal row).
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

      // A single scoring call can leave the stream silent for many seconds;
      // idle proxies kill quiet connections. A comment line (`:` prefix) keeps
      // it warm and is invisible to the EventSource client — no contract change.
      heartbeat = setInterval(() => {
        if (closed) return;
        controller.enqueue(encoder.encode(": keep-alive\n\n"));
      }, 15_000);

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
