// F4 tier dispatch route — thin boundary: exactly-one-of validation +
// Schema.parse, error-class -> ErrorEnvelope mapping. All DB/LLM/Playwright
// access lives in server/apply-assistant/extract-questions.ts
// (api-contract.md §3 "POST /api/apply/questions").
import { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { ExtractionFailedError, UnknownJobError, extractQuestions } from "@/server/apply-assistant/extract-questions";
import { UuidParam } from "@/server/http/params";
import type { ErrorEnvelope } from "@/types";

const RequestBody = z
  .object({
    jobId: UuidParam.optional(),
    url: z.string().min(1).optional(),
    pastedForm: z.string().min(1).optional(),
  })
  .refine((body) => [body.jobId, body.url, body.pastedForm].filter((v) => v !== undefined).length === 1, {
    message: "Exactly one of jobId, url, or pastedForm must be provided.",
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
    const result = await extractQuestions(body);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid apply/questions request.", err.issues);
    }
    if (err instanceof UnknownJobError) {
      return errorResponse(404, "NOT_FOUND", err.message);
    }
    if (err instanceof ExtractionFailedError) {
      return errorResponse(502, "EXTRACTION_FAILED", err.message);
    }
    throw err;
  }
}
