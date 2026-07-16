import { ne } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/errors";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";
import { insertJob, insertJobScore, insertProfile, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { jobs, jobScores, profile, resumes, searchRuns, sources, users } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { requireAdmin } = vi.hoisted(() => ({ requireAdmin: vi.fn() }));
vi.mock("@/server/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/server/auth/session")>()),
  requireAdmin: () => requireAdmin(),
}));

const { GET } = await import("./route");

function req(id: string, query = "") {
  return {
    request: new NextRequest(`http://localhost/api/admin/users/${id}/jobs${query}`),
    params: Promise.resolve({ id }),
  };
}

describe("GET /api/admin/users/[id]/jobs", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  beforeEach(() => {
    requireAdmin.mockReset();
    requireAdmin.mockResolvedValue({ id: BOOTSTRAP_ADMIN_ID, email: "admin@example.com", role: "admin" });
  });

  afterEach(async () => {
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(searchRuns);
    await state.testDb.delete(sources);
    await state.testDb.delete(resumes);
    await state.testDb.delete(profile);
    await state.testDb.delete(users).where(ne(users.id, BOOTSTRAP_ADMIN_ID));
  });

  it("401s with UNAUTHORIZED when there is no session", async () => {
    requireAdmin.mockRejectedValue(new UnauthorizedError());
    const { request, params } = req(crypto.randomUUID());
    const res = await GET(request, { params });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("403s with FORBIDDEN for a normal (non-admin) caller", async () => {
    requireAdmin.mockRejectedValue(new ForbiddenError());
    const { request, params } = req(crypto.randomUUID());
    const res = await GET(request, { params });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
  });

  it("a non-uuid id returns 404 NOT_FOUND", async () => {
    const { request, params } = req("not-a-uuid");
    const res = await GET(request, { params });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("a target user with no profile (not onboarded) returns an empty feed, not a 500", async () => {
    const [userB] = await state.testDb
      .insert(users)
      .values({ email: "target-b-no-profile@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    const { request, params } = req(userB.id);
    const res = await GET(request, { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
    expect(body.stats.scanned).toBe(0);
  });

  it("returns target user B's jobs, not the admin's own or a third user's", async () => {
    const [userB] = await state.testDb
      .insert(users)
      .values({ email: "target-b-jobs@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    await insertProfile(state.testDb, { id: "profile-b", userId: userB.id, relocation: "open" });

    const source = await insertSource(state.testDb);
    const resumeAdmin = await insertResume(state.testDb);
    const resumeB = await insertResume(state.testDb, { userId: userB.id });

    const jobAdmin = await insertJob(state.testDb, source.id, { dedupeKey: "dk-admin-own", url: "https://example.com/admin-own" });
    await insertJobScore(state.testDb, jobAdmin.id, resumeAdmin.id);

    const jobB = await insertJob(state.testDb, source.id, {
      dedupeKey: "dk-target-b",
      url: "https://example.com/target-b",
      userId: userB.id,
    });
    await insertJobScore(state.testDb, jobB.id, resumeB.id, { userId: userB.id });

    const { request, params } = req(userB.id);
    const res = await GET(request, { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual([jobB.id]);
  });

  it("a nonexistent target id behaves like a user with no profile — empty feed, no leak", async () => {
    const { request, params } = req(crypto.randomUUID());
    const res = await GET(request, { params });
    expect(res.status).toBe(200);
    expect((await res.json()).items).toEqual([]);
  });

  it("an unknown query parameter returns 422 VALIDATION_ERROR", async () => {
    const { request, params } = req(crypto.randomUUID(), "?bogus=1");
    const res = await GET(request, { params });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });
});
