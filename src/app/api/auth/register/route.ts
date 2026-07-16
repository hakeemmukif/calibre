// POST /api/auth/register — creates a "user"-role account and auto-logs-in
// (mints a session + sets the cookie). Role is always literal "user"; never
// admin.
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { RegisterRequest, AuthUser, type ErrorEnvelope } from "@/types";
import { usersRepo } from "@/server/persistence/repos/users";
import { sessionsRepo } from "@/server/persistence/repos/sessions";
import { hashPassword } from "@/server/auth/password";
import { mintSessionToken } from "@/server/auth/token";
import { sessionCookieOptions } from "@/server/auth/session";
import { EmailTakenError } from "@/server/auth/errors";
import { checkRegisterLimit } from "@/server/auth/registerLimit";

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string, details?: unknown) {
  return NextResponse.json({ error: { code, message, ...(details !== undefined ? { details } : {}) } }, { status });
}

export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return errorResponse(422, "VALIDATION_ERROR", "Invalid JSON body.");
  }
  try {
    const { email, password, inviteCode } = RegisterRequest.parse(json);

    const expected = process.env.CALIBER_INVITE_CODE;
    if (!expected) throw new Error("CALIBER_INVITE_CODE is not set — registration is invite-gated (membership spec §4.5.2).");
    if (inviteCode !== expected) return errorResponse(403, "FORBIDDEN", "Invalid invite code.");

    // Behind the host Caddy proxy the client IP is the first x-forwarded-for
    // entry; a missing header (direct local dev) degrades to one shared
    // bucket, which is stricter, never looser.
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    if (!checkRegisterLimit(ip)) return errorResponse(429, "RATE_LIMITED", "Too many registrations from this address — try again in an hour.");

    const user = await usersRepo.create({ email, passwordHash: await hashPassword(password), role: "user" });
    const { raw, hash } = mintSessionToken();
    await sessionsRepo.create({ userId: user.id, tokenHash: hash });
    const res = NextResponse.json({ user: AuthUser.parse(user) }, { status: 201 });
    res.cookies.set(sessionCookieOptions(raw));
    return res;
  } catch (err) {
    if (err instanceof ZodError) return errorResponse(422, "VALIDATION_ERROR", "Invalid registration.", err.issues);
    if (err instanceof EmailTakenError) return errorResponse(409, "CONFLICT", err.message);
    throw err;
  }
}
