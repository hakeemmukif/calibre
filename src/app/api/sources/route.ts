// GET /api/sources — Sources management page: ALL rows, both personas,
// disabled included, ordered by name. `Source` (src/types) is the full DB
// row shape; `SourceRef` stays the slim per-job ref embedded in `Job.source`.
// Requires a session (any logged-in user), but the sources DATA itself stays
// global/unscoped — it's admin-managed reference data, not user-owned
// (Step 3 plan Global Constraints: "sources reads stay global").
import { NextResponse } from "next/server";
import { UnauthorizedError } from "@/server/auth/errors";
import { requireUser } from "@/server/auth/session";
import { sourcesRepo } from "@/server/persistence/repos/sources";
import type { ErrorEnvelope } from "@/types";
import { Source } from "@/types";

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string) {
  const body: ErrorEnvelope = { error: { code, message } };
  return NextResponse.json(body, { status });
}

export async function GET() {
  try {
    await requireUser();
    const rows = await sourcesRepo.listAll();
    const items = rows.map((row) => Source.parse(row));
    return NextResponse.json({ items }, { status: 200 });
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    throw err;
  }
}
