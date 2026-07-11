// POST /api/jobs/:id/evaluate (Task 6) — on-demand re-score of a single
// already-persisted job outside a search run. Thin boundary: all DB/LLM
// access lives in server/score/evaluate.ts; mirrors src/app/api/jobs/[id]/route.ts's
// UuidParam guard (malformed id -> 404, never a bare 500 from a bad `uuid` cast).
import { NextRequest, NextResponse } from "next/server";
import { isUuid } from "@/server/http/params";
import { EmptyJobDescriptionError } from "@/server/score";
import { evaluateJob, UnknownJobError } from "@/server/score/evaluate";
import { NoActiveResumeError } from "@/server/search/run";
import type { ErrorEnvelope } from "@/types";

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string, details?: unknown) {
  const body: ErrorEnvelope = { error: { code, message, ...(details !== undefined ? { details } : {}) } };
  return NextResponse.json(body, { status });
}

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return errorResponse(404, "NOT_FOUND", `No job with id "${id}".`);
  }

  try {
    const job = await evaluateJob(id);
    return NextResponse.json(job, { status: 200 });
  } catch (err) {
    if (err instanceof UnknownJobError) {
      return errorResponse(404, "NOT_FOUND", err.message);
    }
    if (err instanceof NoActiveResumeError) {
      return errorResponse(409, "CONFLICT", err.message);
    }
    if (err instanceof EmptyJobDescriptionError) {
      return errorResponse(422, "EXTRACTION_FAILED", err.message);
    }
    // Full detail goes to the log only — an unanticipated DB/driver/LLM
    // message must never leak into the public API body.
    console.error(`POST /api/jobs/${id}/evaluate failed:`, err);
    return errorResponse(500, "INTERNAL", "Internal error.");
  }
}
