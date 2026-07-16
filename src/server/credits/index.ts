// Membership spec §4.2. Admission-time, atomic, and deliberately WITHOUT
// db.transaction(): @libsql/client's file: driver recreates its connection
// when an interactive transaction begins, and concurrent transactions
// corrupt state (perf/scan-overhead 2026-07-16; test-db.ts header). The
// guarded INSERT…SELECT…WHERE below is race-free under SQLite's
// single-writer serialization — the same idiom as claimNextQueued.
import { eq, sql, sum } from "drizzle-orm";
import { getDb } from "@/server/persistence/db";
import { creditLedger, users } from "@/server/persistence/schema";

export const CREDIT_PRICES = { scan: 10, tailor: 8, evaluate: 5, resume: 3, answers: 1 } as const;
export type CreditFeature = keyof typeof CREDIT_PRICES;

export class InsufficientCreditsError extends Error {
  constructor(
    readonly feature: CreditFeature,
    readonly required: number,
    readonly balance: number,
  ) {
    super(`Insufficient credits: ${feature} needs ${required}, balance is ${balance}.`);
    this.name = "InsufficientCreditsError";
  }
}

export async function balance(userId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ total: sum(creditLedger.delta) })
    .from(creditLedger)
    .where(eq(creditLedger.userId, userId));
  return Number(row?.total ?? 0);
}

export async function grant(
  userId: string,
  delta: number,
  reason: "signup" | "purchase" | "admin",
  refId?: string,
): Promise<void> {
  if (!Number.isInteger(delta) || delta === 0) throw new Error(`credit grant delta must be a non-zero integer, got ${delta}`);
  await getDb().insert(creditLedger).values({ userId, delta, reason, refId: refId ?? null });
}

export async function assertAndDebit(
  userId: string,
  feature: CreditFeature,
  opts: { units?: number; refId?: string } = {},
): Promise<void> {
  const units = opts.units ?? 1;
  if (!Number.isInteger(units) || units < 1) throw new Error(`debit units must be a positive integer, got ${units}`);
  const db = getDb();
  const [u] = await db.select({ plan: users.plan, role: users.role }).from(users).where(eq(users.id, userId));
  if (!u) throw new Error(`assertAndDebit: unknown user ${userId}`);
  if (u.plan === "unlimited" || u.role === "admin") return;

  const required = CREDIT_PRICES[feature] * units;
  const res = await db.run(sql`
    INSERT INTO credit_ledger (id, user_id, delta, reason, feature, ref_id, created_at)
    SELECT ${crypto.randomUUID()}, ${userId}, ${-required}, 'debit', ${feature}, ${opts.refId ?? null}, ${Date.now()}
    WHERE (SELECT COALESCE(SUM(delta), 0) FROM credit_ledger WHERE user_id = ${userId}) >= ${required}
  `);
  if (res.rowsAffected === 0) throw new InsufficientCreditsError(feature, required, await balance(userId));
}
