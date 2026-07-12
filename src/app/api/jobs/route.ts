// F2 scored feed route — thin boundary: query validation (unknown params
// rejected, 422) + Schema.parse; all DB/assembly logic lives in
// server/search/jobsFeed.ts (api-contract.md §3 "GET /api/jobs").
import { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { InvalidCursorError } from "@/server/persistence/repos/cursor";
import { listJobsFeed } from "@/server/search/jobsFeed";
import { LegitimacyTier, Persona, type ErrorEnvelope } from "@/types";

const ALLOWED_PARAMS = new Set(["persona", "tier", "minScore", "isNew", "q", "cursor", "limit"]);

// URLSearchParams values are always strings — `z.coerce.boolean()` treats any
// non-empty string (including "false") as true, so booleans need an explicit
// "true"/"false" enum instead.
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

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string, details?: unknown) {
  const body: ErrorEnvelope = { error: { code, message, ...(details !== undefined ? { details } : {}) } };
  return NextResponse.json(body, { status });
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  const unknown = [...new Set(searchParams.keys())].filter((key) => !ALLOWED_PARAMS.has(key));
  if (unknown.length > 0) {
    return errorResponse(422, "VALIDATION_ERROR", `Unknown query parameter(s): ${unknown.join(", ")}`);
  }

  try {
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

    const result = await listJobsFeed(query);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid jobs query.", err.issues);
    }
    if (err instanceof InvalidCursorError) {
      return errorResponse(422, "VALIDATION_ERROR", err.message);
    }
    throw err;
  }
}
