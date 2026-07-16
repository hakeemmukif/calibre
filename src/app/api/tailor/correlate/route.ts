// Correlate kickoff route — thin boundary: Schema.parse + error-class ->
// ErrorEnvelope mapping. All DB/LLM access lives in server/tailor/correlate.ts
// (api-contract.md §3 "POST /api/tailor/correlate"). Mirrors
// src/app/api/tailor/route.ts exactly.
import { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { UuidParam } from "@/server/http/params";
import { UnauthorizedError } from "@/server/auth/errors";
import { requireUser } from "@/server/auth/session";
import { InsufficientCreditsError } from "@/server/credits";
import { NoActiveResumeError, UnknownJobError } from "@/server/tailor";
import { correlate, NoJdFactsError } from "@/server/tailor/correlate";
import type { ErrorEnvelope } from "@/types";

const RequestBody = z.object({ jobId: UuidParam });

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
    const body = RequestBody.parse(json);
    const run = await correlate(session.id, body);
    return NextResponse.json(run, { status: 202 });
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    if (err instanceof ZodError) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid correlate request.", err.issues);
    }
    if (err instanceof UnknownJobError) {
      return errorResponse(404, "NOT_FOUND", err.message);
    }
    if (err instanceof NoActiveResumeError) {
      return errorResponse(409, "CONFLICT", err.message, { reason: "no-resume" });
    }
    if (err instanceof NoJdFactsError) {
      return errorResponse(409, "CONFLICT", err.message, { reason: "no-jdfacts" });
    }
    if (err instanceof InsufficientCreditsError) {
      return errorResponse(402, "INSUFFICIENT_CREDITS", err.message, { feature: err.feature, required: err.required, balance: err.balance });
    }
    throw err;
  }
}
