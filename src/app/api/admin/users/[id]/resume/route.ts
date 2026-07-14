// GET /api/admin/users/[id]/resume — decision #7 admin content access: calls
// the SAME getActiveResume(userId) (which itself calls resumesRepo.getActive)
// the user-facing GET /api/resume calls, just fed the URL's target id instead
// of the caller's own session id (plan 2026-07-14-multitenant-admin.md Step 6
// Task 2). No new unscoped query — no impersonation, the admin reads via the
// target id.
import { NextResponse } from "next/server";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/errors";
import { requireAdmin } from "@/server/auth/session";
import { isUuid } from "@/server/http/params";
import { getActiveResume } from "@/server/resume/ingest";
import type { ErrorEnvelope } from "@/types";

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string) {
  const body: ErrorEnvelope = { error: { code, message } };
  return NextResponse.json(body, { status });
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    await requireAdmin();

    if (!isUuid(id)) {
      return errorResponse(404, "NOT_FOUND", `No user with id "${id}".`);
    }

    const resume = await getActiveResume(id);
    if (!resume) {
      return errorResponse(404, "NOT_FOUND", "No résumé has been uploaded yet.");
    }
    return NextResponse.json(resume, { status: 200 });
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    if (err instanceof ForbiddenError) return errorResponse(403, "FORBIDDEN", err.message);
    throw err;
  }
}
