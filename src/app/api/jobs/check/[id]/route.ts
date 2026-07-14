// F7 pasted-job ingestion poll route — no separate detail entity; the
// UrlCheck row is returned verbatim (spec docs/superpowers/specs/2026-07-12-pasted-job-ingestion-design.md §5).
import { NextRequest, NextResponse } from "next/server";
import { UnauthorizedError } from "@/server/auth/errors";
import { requireUser } from "@/server/auth/session";
import { isUuid } from "@/server/http/params";
import { getUrlCheck } from "@/server/url-check/run";
import type { ErrorEnvelope } from "@/types";

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string, details?: unknown) {
  const body: ErrorEnvelope = { error: { code, message, ...(details !== undefined ? { details } : {}) } };
  return NextResponse.json(body, { status });
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return errorResponse(404, "NOT_FOUND", `No URL check with id "${id}".`);
  }

  try {
    const session = await requireUser();
    const check = await getUrlCheck(id, session.id);
    if (!check) {
      return errorResponse(404, "NOT_FOUND", `No URL check with id "${id}".`);
    }
    return NextResponse.json(check, { status: 200 });
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    throw err;
  }
}
