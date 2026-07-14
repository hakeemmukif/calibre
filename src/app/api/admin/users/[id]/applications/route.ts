// GET /api/admin/users/[id]/applications — decision #7 admin content access:
// calls the SAME listApplications(query, userId) (applicationsRepo.listJoined
// under the hood) the user-facing GET /api/applications calls, just fed the
// URL's target id instead of the caller's own session id (plan
// 2026-07-14-multitenant-admin.md Step 6 Task 2). No new unscoped query — no
// impersonation, the admin reads via the target id.
import { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/errors";
import { requireAdmin } from "@/server/auth/session";
import { isUuid } from "@/server/http/params";
import { InvalidCursorError } from "@/server/persistence/repos/cursor";
import { listApplications } from "@/server/tracker";
import type { ErrorEnvelope } from "@/types";

const StatusTone = z.enum(["good", "verified", "neutral"]);

// Same literal-stage union as the frozen `Application.stage` (src/types) —
// `z.coerce.number()` alone would widen the type back to plain `number`.
const Stage = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const StageParam = z.preprocess((v) => (v === undefined ? undefined : Number(v)), Stage).optional();

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

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const searchParams = request.nextUrl.searchParams;

  try {
    await requireAdmin();

    if (!isUuid(id)) {
      return errorResponse(404, "NOT_FOUND", `No user with id "${id}".`);
    }

    const unknown = [...new Set(searchParams.keys())].filter((key) => !ALLOWED_PARAMS.has(key));
    if (unknown.length > 0) {
      return errorResponse(422, "VALIDATION_ERROR", `Unknown query parameter(s): ${unknown.join(", ")}`);
    }

    const query = QuerySchema.parse({
      stage: searchParams.get("stage") ?? undefined,
      statusTone: searchParams.get("statusTone") ?? undefined,
      cursor: searchParams.get("cursor") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
    });

    const result = await listApplications(query, id);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    if (err instanceof ForbiddenError) return errorResponse(403, "FORBIDDEN", err.message);
    if (err instanceof ZodError) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid applications query.", err.issues);
    }
    if (err instanceof InvalidCursorError) {
      return errorResponse(422, "VALIDATION_ERROR", err.message);
    }
    throw err;
  }
}
