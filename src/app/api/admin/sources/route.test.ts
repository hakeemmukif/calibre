import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/errors";
import { sources } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { requireAdmin } = vi.hoisted(() => ({ requireAdmin: vi.fn() }));
vi.mock("@/server/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/server/auth/session")>()),
  requireAdmin: () => requireAdmin(),
}));

const { GET } = await import("./route");

describe("GET /api/admin/sources", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  beforeEach(() => {
    requireAdmin.mockReset();
    requireAdmin.mockResolvedValue({ id: "admin-1", email: "admin@example.com", role: "admin" });
  });

  afterEach(async () => {
    await state.testDb.delete(sources);
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

  it("200s for an admin: correct aggregates, and items include the dead engine row and a disabled curated row with no health fields", async () => {
    await state.testDb.insert(sources).values([
      // healthy, enabled engine row — not in items
      {
        id: "gh:vercel",
        name: "Vercel",
        kind: "ats",
        persona: "remote",
        enabled: true,
        config: {
          connector: "greenhouse",
          slug: "vercel",
          provenance: ["jobhive"],
          companyDomain: "vercel.com",
          lastValidatedAt: 1_752_700_000_000,
          jobCount: 87,
          consecutiveFailures: 0,
          status: "active",
        },
      },
      // dead engine row — disabled + status dead, in items with health fields
      {
        id: "lever:defunct",
        name: "Defunct Co",
        kind: "ats",
        persona: "remote",
        enabled: false,
        config: {
          connector: "lever",
          slug: "defunct",
          provenance: ["jobhive"],
          companyDomain: "defunct.example",
          lastValidatedAt: 1_752_600_000_000,
          jobCount: 0,
          consecutiveFailures: 6,
          status: "dead",
        },
      },
      // hand-curated row, no health fields, enabled — not in items
      { id: "gh-stripe", name: "Stripe", kind: "ats", persona: "remote", enabled: true, config: { slug: "stripe" } },
      // hand-curated row, no health fields, admin-disabled — in items, health fields absent
      { id: "gh-curated-off", name: "Curated Off", kind: "ats", persona: "remote", enabled: false, config: { slug: "curated-off" } },
    ]);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.total).toBe(4);
    expect(body.enabledCount).toBe(2);
    expect(body.deadCount).toBe(1);
    expect(body.items.map((r: { id: string }) => r.id).sort()).toEqual(["gh-curated-off", "lever:defunct"]);

    const dead = body.items.find((r: { id: string }) => r.id === "lever:defunct");
    expect(dead).toMatchObject({
      status: "dead",
      consecutiveFailures: 6,
      lastValidatedAt: 1_752_600_000_000,
      jobCount: 0,
      provenance: ["jobhive"],
    });

    const curated = body.items.find((r: { id: string }) => r.id === "gh-curated-off");
    expect(curated.enabled).toBe(false);
    expect(curated).not.toHaveProperty("status");
    expect(curated).not.toHaveProperty("consecutiveFailures");
    expect(curated).not.toHaveProperty("provenance");
  });

  it("throws on an engine row with a malformed health field, even when enabled (fail loud, not defaulted, not skipped just because it looks healthy)", async () => {
    await state.testDb.insert(sources).values([
      {
        id: "gh:broken",
        name: "Broken",
        kind: "ats",
        persona: "remote",
        enabled: true,
        config: { connector: "greenhouse", slug: "broken", provenance: ["jobhive"], companyDomain: "broken.example" },
      },
    ]);

    await expect(GET()).rejects.toThrow(/malformed config field/);
  });
});
