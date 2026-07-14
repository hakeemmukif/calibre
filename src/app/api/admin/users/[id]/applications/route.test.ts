import { ne } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/errors";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";
import { insertJob, insertJobScore, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { createResumesRepo } from "@/server/persistence/repos/resumes";
import { applications, jobs, jobScores, resumes, sources, users } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { markApplied } from "@/server/tracker";

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
    request: new NextRequest(`http://localhost/api/admin/users/${id}/applications${query}`),
    params: Promise.resolve({ id }),
  };
}

async function seedAppliedJob(userId: string) {
  const source = await insertSource(state.testDb);
  const resume = await createResumesRepo(state.testDb).insertReplacingActive({
    userId,
    rawText: "Jane Doe — Software Engineer",
    structured: {
      name: "Jane Doe",
      contact: [{ label: "email", value: "jane@example.com" }],
      summary: "Backend engineer.",
      experience: [],
      education: [],
      skills: [],
      extras: [],
    },
    sourceKind: "paste",
    isActive: true,
  });
  const job = await insertJob(state.testDb, source.id, { userId });
  await insertJobScore(state.testDb, job.id, resume.id, { userId });
  const app = await markApplied(userId, { jobId: job.id });
  return { job, resume, app };
}

describe("GET /api/admin/users/[id]/applications", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  beforeEach(() => {
    requireAdmin.mockReset();
    requireAdmin.mockResolvedValue({ id: BOOTSTRAP_ADMIN_ID, email: "admin@example.com", role: "admin" });
  });

  afterEach(async () => {
    await state.testDb.delete(applications);
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(resumes);
    await state.testDb.delete(sources);
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

  it("a target with no applications returns an empty list, not 500", async () => {
    const [userB] = await state.testDb
      .insert(users)
      .values({ email: "target-b-no-apps@example.com", passwordHash: "h", role: "user" })
      .returning();
    const { request, params } = req(userB.id);
    const res = await GET(request, { params });
    expect(res.status).toBe(200);
    expect((await res.json()).items).toEqual([]);
  });

  it("a nonexistent target id behaves like a user with no data (empty list), no leak", async () => {
    const { request, params } = req(crypto.randomUUID());
    const res = await GET(request, { params });
    expect(res.status).toBe(200);
    expect((await res.json()).items).toEqual([]);
  });

  it("returns target user B's applications, not the admin's own or a third user's", async () => {
    const [userB] = await state.testDb
      .insert(users)
      .values({ email: "target-b-apps@example.com", passwordHash: "h", role: "user" })
      .returning();

    await seedAppliedJob(BOOTSTRAP_ADMIN_ID);
    const { app: appB } = await seedAppliedJob(userB.id);

    const { request, params } = req(userB.id);
    const res = await GET(request, { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual([appB.id]);
  });

  it("an unknown query parameter returns 422 VALIDATION_ERROR", async () => {
    const { request, params } = req(crypto.randomUUID(), "?bogus=1");
    const res = await GET(request, { params });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });
});
