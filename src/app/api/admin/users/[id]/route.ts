// PATCH /api/admin/users/[id] — admin plan toggle (membership-credits Task
// 10). Mirrors PATCH /api/sources/:id's requireAdmin + parse-body idiom;
// mirrors the other admin/users/[id]/* routes' isUuid pre-check (decision #7
// admin content access, target-id scoped, not the caller's own session).
import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/errors";
import { requireAdmin } from "@/server/auth/session";
import { isUuid } from "@/server/http/params";
import { usersRepo } from "@/server/persistence/repos/users";
import type { ErrorEnvelope } from "@/types";
import { AdminPlanPatch, AdminUser } from "@/types";

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string, details?: unknown) {
  const body: ErrorEnvelope = { error: { code, message, ...(details !== undefined ? { details } : {}) } };
  return NextResponse.json(body, { status });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    await requireAdmin();

    if (!isUuid(id)) {
      return errorResponse(404, "NOT_FOUND", `No user with id "${id}".`);
    }

    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid JSON body.");
    }
    const body = AdminPlanPatch.parse(json);

    const existing = await usersRepo.findById(id);
    if (!existing) {
      return errorResponse(404, "NOT_FOUND", `No user with id "${id}".`);
    }

    await usersRepo.updatePlan(id, body.plan);

    const rows = await usersRepo.listWithCounts();
    const row = rows.find((r) => r.id === id);
    if (!row) {
      return errorResponse(404, "NOT_FOUND", `No user with id "${id}".`);
    }
    return NextResponse.json(AdminUser.parse({ ...row, createdAt: row.createdAt.toISOString() }), { status: 200 });
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    if (err instanceof ForbiddenError) return errorResponse(403, "FORBIDDEN", err.message);
    if (err instanceof ZodError) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid plan patch.", err.issues);
    }
    throw err;
  }
}
