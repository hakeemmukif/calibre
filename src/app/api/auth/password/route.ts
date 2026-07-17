// PATCH /api/auth/password — self-serve change-password (Task 6, Decision 2).
// Reverifies the CURRENT password, kills EVERY session for the user (a
// leaked session must not survive a password change), THEN rehashes and
// mints a fresh one so the caller stays signed in. Sessions are killed
// before the hash is updated so a crash in between fails closed: the OLD
// password stays valid but every session is already dead, rather than
// leaving a new password set while stale sessions survive. Shares
// updatePasswordHash + deleteAllByUserId with the operator reset script.
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ChangePasswordRequest, AuthUser, type ErrorEnvelope } from "@/types";
import { usersRepo } from "@/server/persistence/repos/users";
import { sessionsRepo } from "@/server/persistence/repos/sessions";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { mintSessionToken } from "@/server/auth/token";
import { requireUser, sessionCookieOptions } from "@/server/auth/session";
import { UnauthorizedError } from "@/server/auth/errors";

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string, details?: unknown) {
  return NextResponse.json({ error: { code, message, ...(details !== undefined ? { details } : {}) } }, { status });
}

export async function PATCH(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return errorResponse(422, "VALIDATION_ERROR", "Invalid JSON body.");
  }
  try {
    const session = await requireUser();
    const { currentPassword, newPassword } = ChangePasswordRequest.parse(json);
    const user = await usersRepo.findById(session.id);
    if (!user) throw new Error(`change-password: session user ${session.id} has no users row`);
    if (!(await verifyPassword(user.passwordHash, currentPassword))) {
      return errorResponse(401, "UNAUTHORIZED", "Current password is incorrect.");
    }
    await sessionsRepo.deleteAllByUserId(user.id);
    await usersRepo.updatePasswordHash(user.id, await hashPassword(newPassword));
    const { raw, hash } = mintSessionToken();
    await sessionsRepo.create({ userId: user.id, tokenHash: hash });
    const res = NextResponse.json({ user: AuthUser.parse(user) }, { status: 200 });
    res.cookies.set(sessionCookieOptions(raw));
    return res;
  } catch (err) {
    if (err instanceof ZodError) return errorResponse(422, "VALIDATION_ERROR", "Invalid change-password body.", err.issues);
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    throw err;
  }
}
