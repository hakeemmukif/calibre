// F4 answer-drafting route — thin boundary: Schema.parse + error-class ->
// ErrorEnvelope mapping. All DB/LLM access lives in
// server/apply-assistant/answer.ts (api-contract.md §3 "POST /api/apply/answers").
import { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { NoActiveResumeError, UnknownJobError, UpstreamLlmError, draftAnswers } from "@/server/apply-assistant/answer";
import { UuidParam } from "@/server/http/params";
import { UnauthorizedError } from "@/server/auth/errors";
import { requireUser } from "@/server/auth/session";
import { ApplicationQuestion, type ErrorEnvelope } from "@/types";

const RequestBody = z.object({
  jobId: UuidParam,
  questions: z.array(ApplicationQuestion).min(1),
});

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
    const result = await draftAnswers(session.id, body);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    if (err instanceof ZodError) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid apply/answers request.", err.issues);
    }
    if (err instanceof UnknownJobError) {
      return errorResponse(404, "NOT_FOUND", err.message);
    }
    if (err instanceof NoActiveResumeError) {
      return errorResponse(409, "CONFLICT", err.message);
    }
    if (err instanceof UpstreamLlmError) {
      return errorResponse(502, "UPSTREAM_LLM_ERROR", err.message);
    }
    throw err;
  }
}
