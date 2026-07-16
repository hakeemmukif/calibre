// POST /api/admin/users/[id]/credits — admin credit grant (membership-credits
// Task 10). Delegates to server/credits' grant(userId, delta, "admin") —
// same append-only ledger every debit writes to, just a positive-or-negative
// admin-reason row instead of a "debit" row. Mirrors the sibling
// admin/users/[id]/* routes' requireAdmin + isUuid idiom.
import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/errors";
import { requireAdmin } from "@/server/auth/session";
import { balance, grant } from "@/server/credits";
import { isUuid } from "@/server/http/params";
import { usersRepo } from "@/server/persistence/repos/users";
import type { ErrorEnvelope } from "@/types";
import { AdminGrantRequest } from "@/types";

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string, details?: unknown) {
  const body: ErrorEnvelope = { error: { code, message, ...(details !== undefined ? { details } : {}) } };
  return NextResponse.json(body, { status });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
    const body = AdminGrantRequest.parse(json);

    const existing = await usersRepo.findById(id);
    if (!existing) {
      return errorResponse(404, "NOT_FOUND", `No user with id "${id}".`);
    }

    await grant(id, body.delta, "admin");
    return NextResponse.json({ balance: await balance(id) }, { status: 200 });
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    if (err instanceof ForbiddenError) return errorResponse(403, "FORBIDDEN", err.message);
    if (err instanceof ZodError) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid grant request.", err.issues);
    }
    throw err;
  }
}
