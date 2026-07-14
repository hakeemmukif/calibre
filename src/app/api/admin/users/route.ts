// GET /api/admin/users — the admin users list with per-user résumé/job/
// application counts (plan 2026-07-14-multitenant-admin.md Step 6 Task 1).
// requireAdmin()-guarded: 401 UNAUTHORIZED with no session, 403 FORBIDDEN for
// a non-admin. `AdminUsersResponse.parse()` strips any stray fields
// (including a would-be passwordHash) — never expose the hash on this route.
import { NextResponse } from "next/server";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/errors";
import { requireAdmin } from "@/server/auth/session";
import { usersRepo } from "@/server/persistence/repos/users";
import type { ErrorEnvelope } from "@/types";
import { AdminUsersResponse } from "@/types";

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string) {
  const body: ErrorEnvelope = { error: { code, message } };
  return NextResponse.json(body, { status });
}

export async function GET() {
  try {
    await requireAdmin();
    const rows = await usersRepo.listWithCounts();
    const items = rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
    return NextResponse.json(AdminUsersResponse.parse({ items }), { status: 200 });
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    if (err instanceof ForbiddenError) return errorResponse(403, "FORBIDDEN", err.message);
    throw err;
  }
}
