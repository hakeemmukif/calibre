// F2 discovery kickoff route — thin boundary: Schema.parse + error-class →
// ErrorEnvelope mapping. All DB/connector access lives in server/search/run.ts
// (api-contract.md §3 "POST /api/search").
import { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { ActiveRunConflictError, NoActiveResumeError, startSearch } from "@/server/search/run";
import { Persona, type ErrorEnvelope } from "@/types";

const RequestBody = z.object({
  persona: Persona,
  sources: z.array(z.string()).min(1).optional(),
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
    const run = await startSearch(body);
    return NextResponse.json(run, { status: 202 });
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid search request.", err.issues);
    }
    if (err instanceof NoActiveResumeError) {
      return errorResponse(409, "CONFLICT", err.message);
    }
    if (err instanceof ActiveRunConflictError) {
      return errorResponse(409, "CONFLICT", err.message, { activeRunId: err.activeRunId });
    }
    throw err;
  }
}
