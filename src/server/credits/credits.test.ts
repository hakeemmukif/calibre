import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { creditLedger, users } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { balance, grant, assertAndDebit, InsufficientCreditsError } = await import("./index");

async function seedUser(overrides: Partial<{ role: "user" | "admin"; plan: "standard" | "unlimited" }> = {}) {
  const id = crypto.randomUUID();
  await state.testDb.insert(users).values({
    id,
    email: `${id}@example.com`,
    passwordHash: "h",
    role: overrides.role ?? "user",
    plan: overrides.plan ?? "standard",
  });
  return id;
}

describe("credits", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  afterEach(async () => {
    await state.testDb.delete(creditLedger);
    await state.testDb.delete(users);
  });

  it("balance sums the ledger; empty ledger is 0", async () => {
    const userId = await seedUser();
    expect(await balance(userId)).toBe(0);
    await grant(userId, 30, "admin");
    await grant(userId, -5, "admin");
    expect(await balance(userId)).toBe(25);
  });

  it("grant then debit: assertAndDebit writes a negative row with feature+refId", async () => {
    const userId = await seedUser();
    await grant(userId, 30, "admin");
    await assertAndDebit(userId, "scan", { refId: "run-1" });
    expect(await balance(userId)).toBe(20);
    const rows = await state.testDb.select().from(creditLedger).where(eq(creditLedger.userId, userId));
    const debitRow = rows.find((r) => r.reason === "debit");
    expect(debitRow?.delta).toBe(-10);
    expect(debitRow?.feature).toBe("scan");
    expect(debitRow?.refId).toBe("run-1");
  });

  it("insufficient: throws InsufficientCreditsError carrying {feature, required, balance}; writes NO row", async () => {
    const userId = await seedUser();
    await grant(userId, 5, "admin");
    let caught: unknown;
    try {
      await assertAndDebit(userId, "scan");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InsufficientCreditsError);
    const err = caught as InstanceType<typeof InsufficientCreditsError>;
    expect(err.feature).toBe("scan");
    expect(err.required).toBe(10);
    expect(err.balance).toBe(5);
    expect(await balance(userId)).toBe(5);
    const rows = await state.testDb.select().from(creditLedger).where(eq(creditLedger.userId, userId));
    expect(rows).toHaveLength(1); // only the admin grant, no debit row
  });

  it("units multiply: answers ×4 debits 4", async () => {
    const userId = await seedUser();
    await grant(userId, 30, "admin");
    await assertAndDebit(userId, "answers", { units: 4 });
    expect(await balance(userId)).toBe(26);
  });

  it("unlimited plan and admin role bypass — resolve without writing any row", async () => {
    const unlimitedUser = await seedUser({ plan: "unlimited" });
    const adminUser = await seedUser({ role: "admin" });
    await assertAndDebit(unlimitedUser, "scan");
    await assertAndDebit(adminUser, "scan");
    expect(await balance(unlimitedUser)).toBe(0);
    expect(await balance(adminUser)).toBe(0);
    const rows = await state.testDb.select().from(creditLedger);
    expect(rows).toHaveLength(0);
  });

  it("grant rejects delta 0 and non-integers (fail loud)", async () => {
    const userId = await seedUser();
    await expect(grant(userId, 0, "admin")).rejects.toThrow();
    await expect(grant(userId, 1.5, "admin")).rejects.toThrow();
    expect(await balance(userId)).toBe(0);
  });

  it("a second 'signup' grant for the same user throws (partial unique index)", async () => {
    const userId = await seedUser();
    await grant(userId, 30, "signup");
    await expect(grant(userId, 30, "signup")).rejects.toThrow();
    expect(await balance(userId)).toBe(30);
  });

  it("concurrency: balance 30, five concurrent scan debits (10 each) → exactly 3 succeed, balance lands at exactly 0, never negative", async () => {
    const userId = await seedUser();
    await grant(userId, 30, "admin");
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => assertAndDebit(userId, "scan")),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(await balance(userId)).toBe(0);
  });
});
