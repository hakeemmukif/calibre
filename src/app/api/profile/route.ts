// GET/PUT /api/profile — the operator profile singleton (spec
// 2026-07-12-remote-local-eligibility-design.md §3/§7). GET 404s when the
// seed row is absent (Resume absence-is-404 pattern); PUT is a full 2-field
// replace. All DB access via profileRepo; wire shape is the frozen Profile.
import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { profileRepo, ProfileMissingError, type ProfileRow } from "@/server/persistence/repos/profile";
import type { ErrorEnvelope } from "@/types";
import { Profile } from "@/types";

const RequestBody = Profile.omit({ updatedAt: true });

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string, details?: unknown) {
  const body: ErrorEnvelope = { error: { code, message, ...(details !== undefined ? { details } : {}) } };
  return NextResponse.json(body, { status });
}

function toWire(row: ProfileRow): Profile {
  return Profile.parse({
    baseCountry: row.baseCountry,
    relocation: row.relocation,
    updatedAt: row.updatedAt.toISOString(),
  });
}

export async function GET() {
  try {
    return NextResponse.json(toWire(await profileRepo.get()), { status: 200 });
  } catch (err) {
    if (err instanceof ProfileMissingError) return errorResponse(404, "NOT_FOUND", err.message);
    throw err;
  }
}

export async function PUT(request: NextRequest) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return errorResponse(422, "VALIDATION_ERROR", "Invalid JSON body.");
  }

  try {
    const body = RequestBody.parse(json);
    const row = await profileRepo.update(body);
    return NextResponse.json(toWire(row), { status: 200 });
  } catch (err) {
    if (err instanceof ZodError) return errorResponse(422, "VALIDATION_ERROR", "Invalid profile.", err.issues);
    if (err instanceof ProfileMissingError) return errorResponse(404, "NOT_FOUND", err.message);
    throw err;
  }
}
