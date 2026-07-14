// F4 answer-edit/regenerate route — thin boundary: Schema.parse + error-class
// -> ErrorEnvelope mapping. All DB access lives in
// server/apply-assistant/answer.ts (api-contract.md §3
// "PATCH /api/apply/answers/:id").
import { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { UnknownAnswersIdError, patchAnswers } from "@/server/apply-assistant/answer";
import { isUuid } from "@/server/http/params";
import { UnauthorizedError } from "@/server/auth/errors";
import { requireUser } from "@/server/auth/session";
import { ApplicationAnswer, type ErrorEnvelope } from "@/types";

const RequestBody = z.object({ answers: z.array(ApplicationAnswer).min(1) });

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string, details?: unknown) {
  const body: ErrorEnvelope = { error: { code, message, ...(details !== undefined ? { details } : {}) } };
  return NextResponse.json(body, { status });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return errorResponse(404, "NOT_FOUND", `No answers with id "${id}".`);
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
    const result = await patchAnswers(id, session.id, body.answers);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    if (err instanceof ZodError) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid apply/answers patch.", err.issues);
    }
    if (err instanceof UnknownAnswersIdError) {
      return errorResponse(404, "NOT_FOUND", err.message);
    }
    throw err;
  }
}
