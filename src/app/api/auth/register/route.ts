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
    const { email, password } = RegisterRequest.parse(json);
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
