// GET/PUT /api/profile — the per-user profile (spec
// 2026-07-12-remote-local-eligibility-design.md §3/§7). GET 404s when the
// caller has no row yet (Resume absence-is-404 pattern); PUT upserts — this
// is the onboarding path, so a fresh registrant's first PUT creates the row
// instead of 404ing. All DB access via profileRepo, scoped to the
// authenticated user; wire shape is the frozen Profile (base
// country/relocation + schedule/employment dials).
import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { profileRepo, ProfileMissingError, type ProfileRow } from "@/server/persistence/repos/profile";
import { requireUser } from "@/server/auth/session";
import { UnauthorizedError } from "@/server/auth/errors";
import type { ErrorEnvelope } from "@/types";
import { Profile, ProfileBase, salaryRules } from "@/types";

const RequestBody = ProfileBase.omit({ updatedAt: true, attrProvenance: true }).superRefine(salaryRules);

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string, details?: unknown) {
  const body: ErrorEnvelope = { error: { code, message, ...(details !== undefined ? { details } : {}) } };
  return NextResponse.json(body, { status });
}

function toWire(row: ProfileRow): Profile {
  return Profile.parse({
    baseCountry: row.baseCountry,
    relocation: row.relocation,
    scheduleFlex: row.scheduleFlex,
    employmentPref: row.employmentPref,
    displayLocation: row.displayLocation,
    targetRole: row.targetRole,
    salaryMin: row.salaryMin,
    salaryMax: row.salaryMax,
    salaryCurrency: row.salaryCurrency,
    salaryCadence: row.salaryCadence,
    attrProvenance: row.attrProvenance,
    updatedAt: row.updatedAt.toISOString(),
  });
}

export async function GET() {
  try {
    const session = await requireUser();
    return NextResponse.json(toWire(await profileRepo.get(session.id)), { status: 200 });
  } catch (err) {
    if (err instanceof ProfileMissingError) return errorResponse(404, "NOT_FOUND", err.message);
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    throw err;
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await requireUser();

    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid JSON body.");
    }

    const body = RequestBody.parse(json);
    const row = await profileRepo.upsert(session.id, body);
    return NextResponse.json(toWire(row), { status: 200 });
  } catch (err) {
    if (err instanceof ZodError) return errorResponse(422, "VALIDATION_ERROR", "Invalid profile.", err.issues);
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    throw err;
  }
}
