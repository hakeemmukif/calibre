// F4 answer-drafting route — thin boundary: Schema.parse + error-class ->
// ErrorEnvelope mapping. All DB/LLM access lives in
// server/apply-assistant/answer.ts (api-contract.md §3 "POST /api/apply/answers").
import { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { NoActiveResumeError, UpstreamLlmError, draftAnswers } from "@/server/apply-assistant/answer";
import { ApplicationQuestion, type ErrorEnvelope } from "@/types";

const RequestBody = z.object({
  jobId: z.string().min(1),
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
    const body = RequestBody.parse(json);
    const result = await draftAnswers(body);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid apply/answers request.", err.issues);
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
