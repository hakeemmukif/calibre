// POST /api/auth/login — verifies credentials and mints a session. Returns
// the identical InvalidCredentialsError/401 for both an unknown email and a
// wrong password, so the response never reveals whether an account exists.
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { LoginRequest, AuthUser, type ErrorEnvelope } from "@/types";
import { usersRepo } from "@/server/persistence/repos/users";
import { sessionsRepo } from "@/server/persistence/repos/sessions";
import { verifyPassword } from "@/server/auth/password";
import { mintSessionToken } from "@/server/auth/token";
import { sessionCookieOptions } from "@/server/auth/session";
import { InvalidCredentialsError } from "@/server/auth/errors";

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
    const { email, password } = LoginRequest.parse(json);
    const user = await usersRepo.findByEmail(email);
    if (!user || !(await verifyPassword(user.passwordHash, password))) throw new InvalidCredentialsError();
    const { raw, hash } = mintSessionToken();
    await sessionsRepo.create({ userId: user.id, tokenHash: hash });
    const res = NextResponse.json({ user: AuthUser.parse(user) }, { status: 200 });
    res.cookies.set(sessionCookieOptions(raw));
    return res;
  } catch (err) {
    if (err instanceof ZodError) return errorResponse(422, "VALIDATION_ERROR", "Invalid login.", err.issues);
    if (err instanceof InvalidCredentialsError) return errorResponse(401, "UNAUTHORIZED", err.message);
    throw err;
  }
}
