import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "@/server/auth/errors";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";
import { insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { sources } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { Source } from "@/types";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { requireUser } = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/server/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/server/auth/session")>()),
  requireUser: () => requireUser(),
}));

const { GET } = await import("./route");

describe("GET /api/sources", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  beforeEach(() => {
    requireUser.mockReset();
    requireUser.mockResolvedValue({ id: BOOTSTRAP_ADMIN_ID, email: "admin@example.com", role: "admin" });
  });

  afterEach(async () => {
    await state.testDb.delete(sources);
  });

  it("401s with UNAUTHORIZED when there is no session", async () => {
    requireUser.mockRejectedValue(new UnauthorizedError());
    const res = await GET();
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("returns every seeded row (both personas, disabled included), each a valid Source", async () => {
    await insertSource(state.testDb, { id: "greenhouse", name: "Greenhouse", persona: "remote", enabled: true });
    await insertSource(state.testDb, { id: "jobstreet", name: "JobStreet", kind: "board", persona: "local", enabled: false });
    await insertSource(state.testDb, { id: "everywhere", name: "Everywhere", kind: "board", persona: "both", enabled: true });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(3);
    for (const item of body.items) {
      expect(() => Source.parse(item)).not.toThrow();
    }
    expect(body.items.map((s: Source) => s.name)).toEqual(["Everywhere", "Greenhouse", "JobStreet"]);
  });
});
