// PATCH /api/sources/:id — enable/disable toggle for the Sources management
// page. Unlike every other `[id]` route in this repo, `sources.id` is a TEXT
// natural key ('greenhouse' | 'lever' | 'ashby' | 'jobstreet' | ... — see
// schema.ts), not a Postgres uuid column. That is deliberate for this branch
// (scan-eval-live: per-company source rows keyed by connector slug), so this
// route does NOT use `UuidParam`/`isUuid` — any non-empty string id is valid
// input, and an unknown one 404s via the repo returning `undefined`.
import { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/errors";
import { requireAdmin } from "@/server/auth/session";
import { sourcesRepo } from "@/server/persistence/repos/sources";
import type { ErrorEnvelope } from "@/types";
import { Source } from "@/types";

const RequestBody = z.object({ enabled: z.boolean() });

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string, details?: unknown) {
  const body: ErrorEnvelope = { error: { code, message, ...(details !== undefined ? { details } : {}) } };
  return NextResponse.json(body, { status });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    await requireAdmin();

    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid JSON body.");
    }

    const body = RequestBody.parse(json);
    const row = await sourcesRepo.setEnabled(id, body.enabled);
    if (!row) {
      return errorResponse(404, "NOT_FOUND", `No source with id "${id}".`);
    }
    return NextResponse.json(Source.parse(row), { status: 200 });
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    if (err instanceof ForbiddenError) return errorResponse(403, "FORBIDDEN", err.message);
    if (err instanceof ZodError) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid source patch.", err.issues);
    }
    throw err;
  }
}
