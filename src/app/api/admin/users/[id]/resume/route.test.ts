import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/errors";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";
import { createResumesRepo } from "@/server/persistence/repos/resumes";
import { resumes, users } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { requireAdmin } = vi.hoisted(() => ({ requireAdmin: vi.fn() }));
vi.mock("@/server/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/server/auth/session")>()),
  requireAdmin: () => requireAdmin(),
}));

const { GET } = await import("./route");

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function insertActiveResume(userId: string, structuredOverrides: Record<string, unknown> = {}) {
  return createResumesRepo(state.testDb).insertReplacingActive({
    userId,
    rawText: "Jane Doe — Software Engineer",
    atsScore: 80,
    structured: {
      storeVersion: 2,
      extractionPath: "text",
      name: "Jane Doe",
      contact: [
        { label: "email", value: "jane@example.com" },
        { label: "location", value: "Kuala Lumpur, Malaysia" },
      ],
      summary: "Backend engineer.",
      experience: [
        { company: "Acme Co", title: "Senior Backend Engineer", dates: "2022–Present", isCurrent: true, bullets: [] },
      ],
      education: [],
      skills: [],
      projects: [],
      certifications: [],
      languages: [],
      sections: [],
      ...structuredOverrides,
    },
    sourceKind: "paste",
    isActive: true,
  });
}

describe("GET /api/admin/users/[id]/resume", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  beforeEach(() => {
    requireAdmin.mockReset();
    requireAdmin.mockResolvedValue({ id: BOOTSTRAP_ADMIN_ID, email: "admin@example.com", role: "admin" });
  });

  afterEach(async () => {
    await state.testDb.delete(resumes);
    const { ne } = await import("drizzle-orm");
    await state.testDb.delete(users).where(ne(users.id, BOOTSTRAP_ADMIN_ID));
  });

  it("401s with UNAUTHORIZED when there is no session", async () => {
    requireAdmin.mockRejectedValue(new UnauthorizedError());
    const res = await GET(new NextRequest("http://localhost/api/admin/users/x/resume"), params(crypto.randomUUID()));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("403s with FORBIDDEN for a normal (non-admin) caller", async () => {
    requireAdmin.mockRejectedValue(new ForbiddenError());
    const res = await GET(new NextRequest("http://localhost/api/admin/users/x/resume"), params(crypto.randomUUID()));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
  });

  it("a non-uuid id returns 404 NOT_FOUND", async () => {
    const res = await GET(new NextRequest("http://localhost/api/admin/users/not-a-uuid/resume"), params("not-a-uuid"));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("a target with no résumé returns 404 NOT_FOUND, not 500", async () => {
    const [userB] = await state.testDb
      .insert(users)
      .values({ email: "target-b-no-resume@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    const res = await GET(new NextRequest("http://localhost/api/admin/users/x/resume"), params(userB.id));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("a nonexistent target id behaves like a user with no data (404), no leak", async () => {
    const res = await GET(new NextRequest("http://localhost/api/admin/users/x/resume"), params(crypto.randomUUID()));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("returns target user B's résumé in the same shape GET /api/resume returns", async () => {
    const [userB] = await state.testDb
      .insert(users)
      .values({ email: "target-b-resume@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    await insertActiveResume(userB.id);

    const res = await GET(new NextRequest("http://localhost/api/admin/users/x/resume"), params(userB.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.headline).toBe("Senior Backend Engineer");
    expect(body.rawText).toBe("Jane Doe — Software Engineer");
    expect(body).toHaveProperty("id");
  });

  it("does not return the caller's own résumé when the target has a different one (target-scoped, not session-scoped)", async () => {
    await insertActiveResume(BOOTSTRAP_ADMIN_ID, { summary: "Admin's own résumé" });
    const [userB] = await state.testDb
      .insert(users)
      .values({ email: "target-b-distinct-resume@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    const targetResume = await insertActiveResume(userB.id, {
      summary: "User B's own résumé, distinct from the admin's.",
    });

    const res = await GET(new NextRequest("http://localhost/api/admin/users/x/resume"), params(userB.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(targetResume.id);
  });
});
