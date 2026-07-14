// F6 finalize route — thin boundary: Schema.parse + error-class ->
// ErrorEnvelope mapping. All merge logic lives in server/tailor/index.ts
// (api-contract.md §3 "POST /api/tailor/:id/finalize").
import { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { isUuid } from "@/server/http/params";
import { UnauthorizedError } from "@/server/auth/errors";
import { requireUser } from "@/server/auth/session";
import {
  InvalidDiffIndexError,
  RunNotReadyError,
  UnknownDiffSectionError,
  UnknownTailorIdError,
  finalizeTailor,
} from "@/server/tailor";
import type { ErrorEnvelope } from "@/types";

const RequestBody = z.object({ acceptedIndices: z.array(z.number().int()) });

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string, details?: unknown) {
  const body: ErrorEnvelope = { error: { code, message, ...(details !== undefined ? { details } : {}) } };
  return NextResponse.json(body, { status });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return errorResponse(404, "NOT_FOUND", `No tailor run with id "${id}".`);
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return errorResponse(422, "VALIDATION_ERROR", "Invalid JSON body.");
  }

  try {
    const session = await requireUser();
    const body = RequestBody.parse(json);
    const result = await finalizeTailor(id, session.id, body.acceptedIndices);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    if (err instanceof ZodError) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid finalize request.", err.issues);
    }
    if (err instanceof UnknownTailorIdError) {
      return errorResponse(404, "NOT_FOUND", err.message);
    }
    if (err instanceof RunNotReadyError) {
      return errorResponse(409, "RUN_NOT_READY", err.message);
    }
    if (err instanceof InvalidDiffIndexError || err instanceof UnknownDiffSectionError) {
      return errorResponse(422, "VALIDATION_ERROR", err.message);
    }
    throw err;
  }
}
