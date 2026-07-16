import { ne } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/errors";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";
import { applications, users } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { requireAdmin } = vi.hoisted(() => ({ requireAdmin: vi.fn() }));
vi.mock("@/server/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/server/auth/session")>()),
  requireAdmin: () => requireAdmin(),
}));

const { GET } = await import("./route");

describe("GET /api/admin/users", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  beforeEach(() => {
    requireAdmin.mockReset();
    requireAdmin.mockResolvedValue({ id: BOOTSTRAP_ADMIN_ID, email: "admin@example.com", role: "admin" });
  });

  afterEach(async () => {
    await state.testDb.delete(applications);
    // keep the migration-seeded bootstrap admin, clear anything the test added
    await state.testDb.delete(users).where(ne(users.id, BOOTSTRAP_ADMIN_ID));
  });

  it("401s with UNAUTHORIZED when there is no session", async () => {
    requireAdmin.mockRejectedValue(new UnauthorizedError());
    const res = await GET();
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("403s with FORBIDDEN for a normal (non-admin) user", async () => {
    requireAdmin.mockRejectedValue(new ForbiddenError());
    const res = await GET();
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
  });

  it("200s for an admin: returns every user with counts and never a passwordHash", async () => {
    await state.testDb.insert(users).values({ id: crypto.randomUUID(), email: "b@x.co", passwordHash: "h", role: "user", plan: "standard" });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(2);
    for (const item of body.items) {
      expect(item).not.toHaveProperty("passwordHash");
      expect(typeof item.resumeCount).toBe("number");
      expect(typeof item.jobCount).toBe("number");
      expect(typeof item.applicationCount).toBe("number");
    }
    expect(body.items.some((u: { email: string }) => u.email === "b@x.co")).toBe(true);
  });
});
