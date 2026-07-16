import { ne } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/errors";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";
import { creditLedger, users } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { requireAdmin } = vi.hoisted(() => ({ requireAdmin: vi.fn() }));
vi.mock("@/server/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/server/auth/session")>()),
  requireAdmin: () => requireAdmin(),
}));

const { PATCH } = await import("./route");
const { assertAndDebit, balance } = await import("@/server/credits");
const { usersRepo } = await import("@/server/persistence/repos/users");

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/users/x", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("PATCH /api/admin/users/[id]", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  beforeEach(() => {
    requireAdmin.mockReset();
    requireAdmin.mockResolvedValue({ id: BOOTSTRAP_ADMIN_ID, email: "admin@example.com", role: "admin" });
  });

  afterEach(async () => {
    await state.testDb.delete(creditLedger);
    await state.testDb.delete(users).where(ne(users.id, BOOTSTRAP_ADMIN_ID));
  });

  it("401s with UNAUTHORIZED when there is no session", async () => {
    requireAdmin.mockRejectedValue(new UnauthorizedError());
    const res = await PATCH(jsonRequest({ plan: "unlimited" }), params(crypto.randomUUID()));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("403s with FORBIDDEN for a normal (non-admin) caller", async () => {
    requireAdmin.mockRejectedValue(new ForbiddenError());
    const res = await PATCH(jsonRequest({ plan: "unlimited" }), params(crypto.randomUUID()));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
  });

  it("flips the plan and returns the updated AdminUser", async () => {
    const u = await usersRepo.create({ email: "flip@x.co", passwordHash: "h", role: "user" });

    const res = await PATCH(jsonRequest({ plan: "unlimited" }), params(u.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(u.id);
    expect(body.plan).toBe("unlimited");
  });

  it("unknown (but valid) uuid -> 404 NOT_FOUND", async () => {
    const res = await PATCH(jsonRequest({ plan: "unlimited" }), params(crypto.randomUUID()));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("bad body ({plan: 'gold'}) -> 422 VALIDATION_ERROR", async () => {
    const u = await usersRepo.create({ email: "bad-body@x.co", passwordHash: "h", role: "user" });
    const res = await PATCH(jsonRequest({ plan: "gold" }), params(u.id));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("flipping to unlimited makes the next assertAndDebit bypass for a zero-balance user", async () => {
    const u = await usersRepo.create({ email: "bypass@x.co", passwordHash: "h", role: "user" });
    expect(await balance(u.id)).toBe(0);

    const res = await PATCH(jsonRequest({ plan: "unlimited" }), params(u.id));
    expect(res.status).toBe(200);

    await expect(assertAndDebit(u.id, "scan")).resolves.toBeUndefined();
  });
});
