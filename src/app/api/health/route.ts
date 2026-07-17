// GET /api/health — liveness for UptimeRobot + on-box alert-check.sh.
// `SELECT 1` proves the DB file is reachable; `llmKeyConfigured` is presence
// only (tracked risk 4: mode:'real' with a blank key looked healthy) — a
// health check must NEVER spend a real LLM call.
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { testDoublesEnabled } from "@/lib/llm/client";
import { getDb } from "@/server/persistence/db";

export async function GET() {
  try {
    await getDb().run(sql`SELECT 1`);
  } catch (err) {
    console.error("health: db ping failed:", err);
    return NextResponse.json({ ok: false }, { status: 503 });
  }
  return NextResponse.json({
    ok: true,
    mode: testDoublesEnabled() ? "doubles" : "real",
    llmKeyConfigured: !!process.env.OPENROUTER_API_KEY,
  });
}
