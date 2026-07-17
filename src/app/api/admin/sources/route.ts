// GET /api/admin/sources — sources health surface (Track O task O.2, spec
// §4.3: dead/disabled sources "visibly disabled with a count on an admin
// surface"). requireAdmin()-guarded, mirrors admin/users/route.ts. Health
// aggregates are JS-computed here over sourcesRepo.listAll() (~850 rows) —
// PINNED: no migration, no new repo method; health fields stay inside the
// JSON `config` column until an admin UI genuinely needs them as columns.
//
// Engine-seeded rows (config.provenance is an array — same isEngineRow test
// freshness.ts uses) carry health fields (status/consecutiveFailures/
// lastValidatedAt/jobCount); a malformed one throws (fail loud, mirrors
// freshness.ts's parseEngineConfig). Hand-curated seed.ts rows carry no
// provenance and so legitimately have none of these fields — that absence
// is not a failure; such a row can still appear in `items` (if an admin
// disabled it) with the health fields simply omitted.
import { NextResponse } from "next/server";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/errors";
import { requireAdmin } from "@/server/auth/session";
import { sourcesRepo } from "@/server/persistence/repos/sources";
import type { ErrorEnvelope, SourceHealthRow } from "@/types";
import { SourcesHealthResponse } from "@/types";

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string) {
  const body: ErrorEnvelope = { error: { code, message } };
  return NextResponse.json(body, { status });
}

function isEngineRow(config: Record<string, unknown>): boolean {
  return Array.isArray(config.provenance);
}

// Only ever called on an engine row (isEngineRow already true) — fails loud
// on a malformed health field rather than defaulting around it.
function healthFieldsOf(id: string, config: Record<string, unknown>) {
  const bad = (field: string, value: unknown) =>
    new Error(`admin/sources: engine source "${id}" has malformed config field "${field}" (got ${JSON.stringify(value)})`);
  const { status, consecutiveFailures, lastValidatedAt, jobCount, provenance } = config;
  if (status !== "active" && status !== "dead") throw bad("status", status);
  if (typeof consecutiveFailures !== "number") throw bad("consecutiveFailures", consecutiveFailures);
  if (typeof lastValidatedAt !== "number") throw bad("lastValidatedAt", lastValidatedAt);
  if (typeof jobCount !== "number") throw bad("jobCount", jobCount);
  if (!Array.isArray(provenance)) throw bad("provenance", provenance);
  return {
    status: status as "active" | "dead",
    consecutiveFailures,
    lastValidatedAt,
    jobCount,
    provenance: provenance as string[],
  };
}

export async function GET() {
  try {
    await requireAdmin();
    const rows = await sourcesRepo.listAll();

    let enabledCount = 0;
    let deadCount = 0;
    const items: SourceHealthRow[] = [];
    for (const row of rows) {
      const config = row.config as Record<string, unknown>;
      if (row.enabled) enabledCount++;
      // Validated unconditionally for every engine row (not only ones that
      // end up in `items`) — same boundary discipline as freshness.ts's
      // parseEngineConfig, which runs over every engine row it sees.
      const health = isEngineRow(config) ? healthFieldsOf(row.id, config) : undefined;
      const dead = health?.status === "dead";
      if (dead) deadCount++;
      if (dead || !row.enabled) {
        items.push({ id: row.id, name: row.name, enabled: row.enabled, ...health });
      }
    }

    const body = { total: rows.length, enabledCount, deadCount, items };
    return NextResponse.json(SourcesHealthResponse.parse(body), { status: 200 });
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    if (err instanceof ForbiddenError) return errorResponse(403, "FORBIDDEN", err.message);
    throw err;
  }
}
