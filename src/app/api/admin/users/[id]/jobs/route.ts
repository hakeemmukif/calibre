// GET /api/admin/users/[id]/jobs — decision #7 admin content access: calls
// the SAME listJobsFeed(query, userId) the user-facing GET /api/jobs calls,
// just fed the URL's target id instead of the caller's own session id (plan
// 2026-07-14-multitenant-admin.md Step 6 Task 2). No new unscoped query — no
// impersonation, the admin reads via the target id.
import { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/errors";
import { requireAdmin } from "@/server/auth/session";
import { isUuid } from "@/server/http/params";
import { InvalidCursorError } from "@/server/persistence/repos/cursor";
import { ProfileMissingError } from "@/server/persistence/repos/profile";
import { listJobsFeed } from "@/server/search/jobsFeed";
import { LegitimacyTier, Persona, type ErrorEnvelope } from "@/types";

const ALLOWED_PARAMS = new Set(["persona", "tier", "minScore", "isNew", "q", "cursor", "limit"]);

// URLSearchParams values are always strings — `z.coerce.boolean()` treats any
// non-empty string (including "false") as true, so booleans need an explicit
// "true"/"false" enum instead (mirrors GET /api/jobs).
const BooleanParam = z
  .enum(["true", "false"])
  .transform((v) => v === "true")
  .optional();

const QuerySchema = z.object({
  persona: Persona.optional(),
  tier: z.array(LegitimacyTier).optional(),
  minScore: z.coerce.number().min(0).max(5).optional(),
  isNew: BooleanParam,
  q: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// The empty feed shape returned when the target hasn't onboarded yet
// (ProfileMissingError) — an admin peeking at a not-yet-onboarded account
// shouldn't 500; there's by definition no feed to show yet.
const EMPTY_FEED = {
  items: [],
  nextCursor: null,
  stats: { scanned: 0, worth: 0, ghosts: 0, flagged: 0, sinceLast: 0, excluded: 0 },
};

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

    const tier = searchParams.getAll("tier");
    const query = QuerySchema.parse({
      persona: searchParams.get("persona") ?? undefined,
      tier: tier.length > 0 ? tier : undefined,
      minScore: searchParams.get("minScore") ?? undefined,
      isNew: searchParams.get("isNew") ?? undefined,
      q: searchParams.get("q") ?? undefined,
      cursor: searchParams.get("cursor") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
    });

    try {
      const result = await listJobsFeed(query, id);
      return NextResponse.json(result, { status: 200 });
    } catch (err) {
      if (err instanceof ProfileMissingError) {
        return NextResponse.json(EMPTY_FEED, { status: 200 });
      }
      throw err;
    }
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    if (err instanceof ForbiddenError) return errorResponse(403, "FORBIDDEN", err.message);
    if (err instanceof ZodError) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid jobs query.", err.issues);
    }
    if (err instanceof InvalidCursorError) {
      return errorResponse(422, "VALIDATION_ERROR", err.message);
    }
    throw err;
  }
}
