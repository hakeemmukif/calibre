// F6 tailor kickoff route — thin boundary: Schema.parse + error-class ->
// ErrorEnvelope mapping. All DB/LLM access lives in server/tailor/index.ts
// (api-contract.md §3 "POST /api/tailor").
import { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { NoActiveResumeError, UnknownJobError, startTailor } from "@/server/tailor";
import type { ErrorEnvelope } from "@/types";

const RequestBody = z.object({ jobId: z.string().min(1) });

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
    const run = await startTailor(body);
    return NextResponse.json(run, { status: 202 });
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid tailor request.", err.issues);
    }
    if (err instanceof UnknownJobError) {
      return errorResponse(404, "NOT_FOUND", err.message);
    }
    if (err instanceof NoActiveResumeError) {
      return errorResponse(409, "CONFLICT", err.message);
    }
    throw err;
  }
}
