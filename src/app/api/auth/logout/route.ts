// POST /api/auth/logout — deletes the session (if any) and clears the
// cookie. Idempotent: no cookie / an already-deleted session is not an
// error.
import { NextRequest, NextResponse } from "next/server";
import { sessionsRepo } from "@/server/persistence/repos/sessions";
import { hashToken } from "@/server/auth/token";
import { SESSION_COOKIE, clearedCookieOptions } from "@/server/auth/session";

export async function POST(request: NextRequest) {
  const raw = request.cookies.get(SESSION_COOKIE)?.value;
  if (raw) await sessionsRepo.deleteByTokenHash(hashToken(raw));
  const res = new NextResponse(null, { status: 204 });
  res.cookies.set(clearedCookieOptions());
  return res;
}
