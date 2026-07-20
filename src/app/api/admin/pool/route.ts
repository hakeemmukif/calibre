// GET /api/admin/pool — Admin Pool tab (spec 2026-07-21-admin-pool-tab-
// design.md §5): a read-only snapshot of the global postings pool's
// composition (function mix, tz bands, freshness, company concentration).
// requireAdmin()-guarded, mirrors admin/sources/route.ts's shape. ZERO LLM
// calls; one repo aggregate (poolStatsRepo.getPoolStats) over
// postings/sources.
import { NextResponse } from "next/server";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/errors";
import { requireAdmin } from "@/server/auth/session";
import { poolStatsRepo } from "@/server/persistence/repos/poolStats";
import { AdminPoolStats } from "@/types";
import type { ErrorEnvelope } from "@/types";

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string) {
  const body: ErrorEnvelope = { error: { code, message } };
  return NextResponse.json(body, { status });
}

export async function GET() {
  try {
    await requireAdmin();
    const stats = await poolStatsRepo.getPoolStats(Date.now());
    return NextResponse.json(AdminPoolStats.parse(stats), { status: 200 });
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    if (err instanceof ForbiddenError) return errorResponse(403, "FORBIDDEN", err.message);
    throw err;
  }
}
