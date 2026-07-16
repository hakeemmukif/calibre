// F7 pasted-job ingestion kickoff route — thin boundary: Schema.parse +
// error-class -> ErrorEnvelope mapping. All DB/LLM access lives in
// server/url-check/run.ts (spec docs/superpowers/specs/2026-07-12-pasted-job-ingestion-design.md §5/§6).
//
// Brief-vs-Task-12 reconciliation (controller-ruled, task-13 BLOCKED report):
// - NoActiveResumeError is imported from its home module @/server/search/run
//   (same precedent as src/server/score/evaluate.ts:11), not re-exported
//   from @/server/url-check/run — run.ts only imports it privately there.
// - The 40k-char text cap (§6 admission step 3) is NOT re-checked here.
//   startUrlCheck already enforces it in sync admission and throws
//   PayloadTooLargeError (Task 12) — a route-level duplicate would be a
//   second source of truth, so this route just maps that error class.
import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { UnauthorizedError } from "@/server/auth/errors";
import { requireUser } from "@/server/auth/session";
import { InsufficientCreditsError } from "@/server/credits";
import { NoActiveResumeError } from "@/server/search/run";
import { listActiveChecks, listChecksByIds, PayloadTooLargeError, startUrlCheck } from "@/server/url-check/run";
import { UrlCheckRequest, type ErrorEnvelope } from "@/types";

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string, details?: unknown) {
  const body: ErrorEnvelope = { error: { code, message, ...(details !== undefined ? { details } : {}) } };
  return NextResponse.json(body, { status });
}

export async function POST(request: NextRequest) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return errorResponse(422, "VALIDATION_ERROR", "Invalid JSON body.");
  }

  try {
    const session = await requireUser();
    const body = UrlCheckRequest.parse(json);
    const { check, started } = await startUrlCheck(body, session.id);
    return NextResponse.json(check, { status: started ? 202 : 200 });
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    if (err instanceof InsufficientCreditsError) {
      return errorResponse(402, "INSUFFICIENT_CREDITS", err.message, { feature: err.feature, required: err.required, balance: err.balance });
    }
    if (err instanceof ZodError) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid URL-check request.", err.issues);
    }
    if (err instanceof NoActiveResumeError) {
      return errorResponse(409, "CONFLICT", err.message);
    }
    if (err instanceof PayloadTooLargeError) {
      return errorResponse(422, "PAYLOAD_TOO_LARGE", err.message);
    }
    throw err;
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  try {
    const session = await requireUser();
    if (searchParams.get("active") === "1") {
      return NextResponse.json(await listActiveChecks(session.id), { status: 200 });
    }
    const idsParam = searchParams.get("ids");
    if (idsParam !== null) {
      const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean);
      return NextResponse.json(await listChecksByIds(ids, session.id), { status: 200 });
    }
    return errorResponse(422, "VALIDATION_ERROR", "Provide ?ids=<csv> or ?active=1.");
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    throw err;
  }
}
