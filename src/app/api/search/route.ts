// F2 discovery kickoff route — thin boundary: Schema.parse + error-class →
// ErrorEnvelope mapping. All DB/connector access lives in server/search/run.ts
// (api-contract.md §3 "POST /api/search").
import { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { InsufficientCreditsError } from "@/server/credits";
import { InvalidCursorError } from "@/server/persistence/repos/cursor";
import { searchRunsRepo } from "@/server/persistence/repos/searchRuns";
import { UnauthorizedError } from "@/server/auth/errors";
import { requireUser } from "@/server/auth/session";
import { toSearchRunSummary } from "@/server/search/assemble-summary";
import { ActiveRunConflictError, NoActiveResumeError, UnknownSourceIdsError, startSearch } from "@/server/search/run";
import { ScanPersona, type ErrorEnvelope } from "@/types";

const RequestBody = z.object({
  persona: ScanPersona,
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
    const session = await requireUser();
    const body = RequestBody.parse(json);
    const run = await startSearch(session.id, body);
    return NextResponse.json(run, { status: 202 });
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    if (err instanceof InsufficientCreditsError) {
      return errorResponse(402, "INSUFFICIENT_CREDITS", err.message, { feature: err.feature, required: err.required, balance: err.balance });
    }
    if (err instanceof ZodError) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid search request.", err.issues);
    }
    if (err instanceof UnknownSourceIdsError) {
      return errorResponse(422, "VALIDATION_ERROR", err.message, { unknownSourceIds: err.unknownIds });
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

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireUser();
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    if (limitRaw !== null && (!Number.isInteger(limit) || limit! < 1)) {
      return errorResponse(422, "VALIDATION_ERROR", "limit must be a positive integer");
    }
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const page = await searchRunsRepo.listByUser(session.id, { limit, cursor });
    return NextResponse.json({ items: page.items.map(toSearchRunSummary), nextCursor: page.nextCursor }, { status: 200 });
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    if (err instanceof InvalidCursorError) return errorResponse(422, "VALIDATION_ERROR", err.message);
    throw err;
  }
}
