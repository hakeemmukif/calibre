// GET /api/auth/session — returns the current user from the session
// cookie, or 401 if unauthenticated.
import { NextResponse } from "next/server";
import { SessionResponse, type ErrorEnvelope } from "@/types";
import { getSession } from "@/server/auth/session";

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET() {
  const user = await getSession();
  if (!user) return errorResponse(401, "UNAUTHORIZED", "Authentication required.");
  return NextResponse.json(SessionResponse.parse({ user }), { status: 200 });
}
