// F5 tracker routes — thin boundary: Schema.parse + error-class -> ErrorEnvelope
// mapping. All DB access lives in server/tracker/index.ts (api-contract.md §3
// "POST /api/applications", "GET /api/applications").
import { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { InvalidCursorError } from "@/server/persistence/repos/cursor";
import { UuidParam } from "@/server/http/params";
import {
  ApplicationConflictError,
  JobNotScoredError,
  NoActiveResumeError,
  UnknownJobError,
  listApplications,
  markApplied,
} from "@/server/tracker";
import type { ErrorEnvelope } from "@/types";

const StatusTone = z.enum(["good", "verified", "neutral"]);

// Same literal-stage union as the frozen `Application.stage` (src/types) —
// `z.coerce.number()` alone would widen the type back to plain `number`.
const Stage = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const StageParam = z.preprocess((v) => (v === undefined ? undefined : Number(v)), Stage).optional();

const RequestBody = z.object({
  jobId: UuidParam,
  note: z.string().optional(),
  tailoredResumeId: z.string().optional(),
  answersId: z.string().optional(),
});

const ALLOWED_PARAMS = new Set(["stage", "statusTone", "cursor", "limit"]);

const QuerySchema = z.object({
  stage: StageParam,
  statusTone: StatusTone.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
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
    const app = await markApplied(body);
    return NextResponse.json(app, { status: 201 });
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid application request.", err.issues);
    }
    if (err instanceof ApplicationConflictError) {
      return errorResponse(409, "CONFLICT", err.message, { existingId: err.existingId });
    }
    if (err instanceof UnknownJobError) {
      return errorResponse(404, "NOT_FOUND", err.message);
    }
    if (err instanceof JobNotScoredError) {
      return errorResponse(409, "CONFLICT", err.message);
    }
    if (err instanceof NoActiveResumeError) {
      return errorResponse(409, "CONFLICT", err.message);
    }
    throw err;
  }
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  const unknown = [...new Set(searchParams.keys())].filter((key) => !ALLOWED_PARAMS.has(key));
  if (unknown.length > 0) {
    return errorResponse(422, "VALIDATION_ERROR", `Unknown query parameter(s): ${unknown.join(", ")}`);
  }

  try {
    const query = QuerySchema.parse({
      stage: searchParams.get("stage") ?? undefined,
      statusTone: searchParams.get("statusTone") ?? undefined,
      cursor: searchParams.get("cursor") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
    });

    const result = await listApplications(query);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid applications query.", err.issues);
    }
    if (err instanceof InvalidCursorError) {
      return errorResponse(422, "VALIDATION_ERROR", err.message);
    }
    throw err;
  }
}
