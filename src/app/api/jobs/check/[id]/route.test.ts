import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "@/server/auth/errors";
import { urlChecksRepo } from "@/server/persistence/repos/urlChecks";
import { urlChecks, users } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { requireUser } = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/server/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/server/auth/session")>()),
  requireUser: () => requireUser(),
}));

const { GET } = await import("./route");

function req(): NextRequest {
  return new NextRequest("http://localhost/api/jobs/check/anything");
}

describe("GET /api/jobs/check/:id", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  beforeEach(() => {
    requireUser.mockReset();
    requireUser.mockResolvedValue({ id: BOOTSTRAP_ADMIN_ID, email: "admin@example.com", role: "admin" });
  });

  afterEach(async () => {
    await state.testDb.delete(urlChecks);
  });

  it("401s with UNAUTHORIZED when there is no session", async () => {
    requireUser.mockRejectedValue(new UnauthorizedError());
    const res = await GET(req(), { params: Promise.resolve({ id: crypto.randomUUID() }) });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("returns the UrlCheck row for a known id", async () => {
    const row = await urlChecksRepo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      url: "https://example.com/job/1",
      dedupeKey: "example.com/job/1",
      status: "queued",
      stage: null,
      jobId: null,
      alreadyKnown: false,
      needsText: false,
      error: null,
      costUsd: 0,
      raw: {},
    });

    const res = await GET(req(), { params: Promise.resolve({ id: row.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(row.id);
    expect(body.status).toBe("queued");
  });

  it("returns 404 for a foreign-owned check id (cross-tenant isolation, no existence leak)", async () => {
    const [userB] = await state.testDb
      .insert(users)
      .values({ email: `user-b-jobs-check-id-route-${crypto.randomUUID()}@example.com`, passwordHash: "h", role: "user" })
      .returning();
    const row = await urlChecksRepo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      url: "https://example.com/job/foreign",
      dedupeKey: "example.com/job/foreign",
      status: "queued",
      stage: null,
      jobId: null,
      alreadyKnown: false,
      needsText: false,
      error: null,
      costUsd: 0,
      raw: {},
    });

    requireUser.mockResolvedValue({ id: userB.id, email: userB.email, role: "user" });
    const res = await GET(req(), { params: Promise.resolve({ id: row.id }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("returns 404 for an unknown id", async () => {
    const res = await GET(req(), { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("returns 404 NOT_FOUND for a malformed (non-uuid) id, never a 500", async () => {
    const res = await GET(req(), { params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });
});
