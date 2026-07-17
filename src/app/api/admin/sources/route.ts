// GET /api/admin/sources — sources health surface (Track O task O.2, spec
// §4.3: dead/disabled sources "visibly disabled with a count on an admin
// surface"). requireAdmin()-guarded, mirrors admin/users/route.ts. Health
// aggregates are JS-computed here over sourcesRepo.listAll() (~850 rows) —
// PINNED: no migration, no new repo method; health fields stay inside the
// JSON `config` column until an admin UI genuinely needs them as columns.
//
// Engine-seeded rows (config.provenance is an array — same isEngineRow test
// freshness.ts uses) carry health fields (status/consecutiveFailures/
// lastValidatedAt/jobCount); a malformed one is reported on that row via
// `error`, not thrown — this surface exists to make sick sources visible,
// so a bad row must not 500 the whole admin page (users+credits included).
// Mirrors freshness.ts's row-level failure philosophy (FreshnessPassError):
// fail loud on the row, keep the pass going. Hand-curated seed.ts rows carry
// no provenance and so legitimately have none of these fields — that
// absence is not a failure; such a row can still appear in `items` (if an
// admin disabled it) with the health fields simply omitted.
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

type HealthFields = {
  status: "active" | "dead";
  consecutiveFailures: number;
  lastValidatedAt: number;
  jobCount: number;
  provenance: string[];
};

// Only ever called on an engine row (isEngineRow already true). Reports a
// malformed field on the row rather than throwing — this row is a problem to
// surface, not to hide, and a bad row must never abort the whole request.
function healthFieldsOf(
  id: string,
  config: Record<string, unknown>,
): { ok: true; health: HealthFields } | { ok: false; error: string } {
  const bad = (field: string, value: unknown): { ok: false; error: string } => ({
    ok: false,
    error: `admin/sources: engine source "${id}" has malformed config field "${field}" (got ${JSON.stringify(value)})`,
  });
  const { status, consecutiveFailures, lastValidatedAt, jobCount, provenance } = config;
  if (status !== "active" && status !== "dead") return bad("status", status);
  if (typeof consecutiveFailures !== "number") return bad("consecutiveFailures", consecutiveFailures);
  if (typeof lastValidatedAt !== "number") return bad("lastValidatedAt", lastValidatedAt);
  if (typeof jobCount !== "number") return bad("jobCount", jobCount);
  if (!Array.isArray(provenance)) return bad("provenance", provenance);
  return {
    ok: true,
    health: {
      status: status as "active" | "dead",
      consecutiveFailures,
      lastValidatedAt,
      jobCount,
      provenance: provenance as string[],
    },
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
      // N2: "manual" (seed.ts) is the pasted-URL pseudo-source — structurally
      // always disabled, not a dead/disabled crawl source. It still counts
      // toward `total` above (rows.length) but never appears in `items`.
      if (row.id === "manual") continue;
      // Validated unconditionally for every engine row (not only ones that
      // end up in `items`) — same boundary discipline as freshness.ts's
      // parseEngineConfig, which runs over every engine row it sees.
      const result = isEngineRow(config) ? healthFieldsOf(row.id, config) : undefined;
      const dead = result?.ok === true && result.health.status === "dead";
      if (dead) deadCount++;
      if (result && !result.ok) {
        // Malformed engine row: surfaced, not fatal, and not hidden even if
        // the row happens to be enabled — a broken config is itself the
        // problem to show.
        items.push({ id: row.id, name: row.name, enabled: row.enabled, error: result.error });
      } else if (dead || !row.enabled) {
        items.push({ id: row.id, name: row.name, enabled: row.enabled, ...(result?.ok ? result.health : {}) });
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
