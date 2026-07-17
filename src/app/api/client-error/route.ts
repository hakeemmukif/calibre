// POST /api/client-error — the crash beacon (pre-launch hardening Task 4).
// Order is load-bearing: per-IP limit → size cap (BEFORE JSON.parse) →
// Schema.parse → optional session (an unauthenticated /login crash must
// still report) → one-line [client-error] JSON log (alert-check.sh's
// threshold class matches that literal). userId is attached server-side
// only. Responds 204; the client fires-and-forgets via sendBeacon.
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ClientErrorReport, type ErrorEnvelope } from "@/types";
import { getSession } from "@/server/auth/session";
import { checkClientErrorLimit } from "@/server/http/clientErrorLimit";

const MAX_BODY_BYTES = 16_384; // schema maxima sum to ~12.2KB — headroom, not open-ended

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!checkClientErrorLimit(ip)) {
    return errorResponse(429, "RATE_LIMITED", "Too many error reports from this address.");
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return errorResponse(413, "PAYLOAD_TOO_LARGE", `Report exceeds ${MAX_BODY_BYTES} bytes.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return errorResponse(422, "VALIDATION_ERROR", "Invalid JSON body.");
  }
  try {
    const report = ClientErrorReport.parse(json);
    const session = await getSession();
    console.error("[client-error]", JSON.stringify({ ...report, userId: session?.id ?? null }));
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof ZodError) return errorResponse(422, "VALIDATION_ERROR", "Invalid report shape.");
    throw err;
  }
}
