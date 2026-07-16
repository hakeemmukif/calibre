import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { creditLedger, users } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { UnauthorizedError } from "@/server/auth/errors";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { requireUser } = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/server/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/server/auth/session")>()),
  requireUser: () => requireUser(),
}));

const { GET } = await import("./route");

async function seedUser(plan: "standard" | "unlimited" = "standard") {
  const id = crypto.randomUUID();
  await state.testDb.insert(users).values({ id, email: `${id}@example.com`, passwordHash: "h", role: "user", plan });
  return id;
}

describe("GET /api/credits", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  beforeEach(() => {
    requireUser.mockReset();
  });

  afterEach(async () => {
    await state.testDb.delete(creditLedger);
    await state.testDb.delete(users);
  });

  it("401s with UNAUTHORIZED when there is no session", async () => {
    requireUser.mockRejectedValue(new UnauthorizedError());
    const res = await GET();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("200s with the caller's balance and plan after +30/-5 ledger rows", async () => {
    const userId = await seedUser("standard");
    await state.testDb.insert(creditLedger).values([
      { userId, delta: 30, reason: "signup" },
      { userId, delta: -5, reason: "debit", feature: "scan" },
    ]);
    requireUser.mockResolvedValue({ id: userId, email: "u@example.com", role: "user" });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ balance: 25, plan: "standard" });
  });

  it("returns plan: 'unlimited' for an unlimited-plan user", async () => {
    const userId = await seedUser("unlimited");
    requireUser.mockResolvedValue({ id: userId, email: "u@example.com", role: "user" });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ balance: 0, plan: "unlimited" });
  });
});
