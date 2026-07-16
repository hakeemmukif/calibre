import { cache } from "react";
import { cookies } from "next/headers";
import { AuthUser } from "@/types";
import { sessionsRepo } from "@/server/persistence/repos/sessions";
import { hashToken } from "./token";
import { UnauthorizedError, ForbiddenError } from "./errors";

export const SESSION_COOKIE = "caliber_session";
const THIRTY_DAYS = 60 * 60 * 24 * 30; // mirrored by SESSION_TTL_MS in repos/sessions.ts — change both together.

// Secure in prod; overridable for local http via SESSION_COOKIE_SECURE=false.
const secure = process.env.SESSION_COOKIE_SECURE !== "false";

export function sessionCookieOptions(raw: string) {
  return { name: SESSION_COOKIE, value: raw, httpOnly: true, secure, sameSite: "lax" as const, path: "/", maxAge: THIRTY_DAYS };
}
export function clearedCookieOptions() {
  return { name: SESSION_COOKIE, value: "", httpOnly: true, secure, sameSite: "lax" as const, path: "/", maxAge: 0 };
}

export async function resolveSessionFromToken(raw: string | undefined): Promise<AuthUser | null> {
  if (!raw) return null;
  const row = await sessionsRepo.findUserByTokenHash(hashToken(raw));
  if (!row) return null;
  return AuthUser.parse(row); // strips passwordHash/createdAt
}

export const getSession = cache(async (): Promise<AuthUser | null> => {
  const store = await cookies();
  return resolveSessionFromToken(store.get(SESSION_COOKIE)?.value);
});

export async function requireUser(): Promise<AuthUser> {
  const user = await getSession();
  if (!user) throw new UnauthorizedError();
  return user;
}

export async function requireAdmin(): Promise<AuthUser> {
  const user = await requireUser();
  if (user.role !== "admin") throw new ForbiddenError();
  return user;
}
