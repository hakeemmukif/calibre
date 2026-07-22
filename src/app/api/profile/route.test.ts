import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { profile, users } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { Profile } from "@/types";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";
import { UnauthorizedError } from "@/server/auth/errors";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { requireUser } = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/server/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/server/auth/session")>()),
  requireUser: () => requireUser(),
}));

const { GET, PUT } = await import("./route");

function putRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/profile", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/profile", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  beforeEach(() => {
    requireUser.mockReset();
    requireUser.mockResolvedValue({ id: BOOTSTRAP_ADMIN_ID, email: "admin@example.com", role: "admin" });
  });

  afterEach(async () => {
    await state.testDb.delete(profile);
  });

  it("GET 401s with UNAUTHORIZED when there is no session", async () => {
    requireUser.mockRejectedValue(new UnauthorizedError());
    const res = await GET();
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("PUT 401s with UNAUTHORIZED when there is no session", async () => {
    requireUser.mockRejectedValue(new UnauthorizedError());
    const res = await PUT(
      putRequest({
        baseCountry: "MY", relocation: "open",
        displayLocation: null, targetRole: null, salaryMin: null, salaryMax: null, salaryCurrency: null, salaryCadence: null,
      }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("GET 404s with NOT_FOUND when the caller has no profile row (Resume absence pattern)", async () => {
    const res = await GET();
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("GET returns the caller's row as a valid Profile", async () => {
    await state.testDb.insert(profile).values({ id: "default", userId: BOOTSTRAP_ADMIN_ID, baseCountry: "MY", relocation: "stay", scheduleFlex: "any-hours", employmentPref: "any" });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(() => Profile.parse(body)).not.toThrow();
    expect(body.relocation).toBe("stay");
    expect(body.attrProvenance).toEqual({});
  });

  it("PUT creates the caller's row when none exists (onboarding path)", async () => {
    const res = await PUT(
      putRequest({
        baseCountry: "MY", relocation: "open", scheduleFlex: "any-hours", employmentPref: "any",
        displayLocation: null, targetRole: null, salaryMin: null, salaryMax: null, salaryCurrency: null, salaryCadence: null,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Profile.parse(body).relocation).toBe("open");
    expect(body.attrProvenance).toEqual({});

    const getRes = await GET();
    expect(getRes.status).toBe(200);
  });

  it("PUT upserts (full-replaces) an existing row and returns the updated Profile", async () => {
    await state.testDb.insert(profile).values({ id: "default", userId: BOOTSTRAP_ADMIN_ID, baseCountry: "MY", relocation: "stay", scheduleFlex: "any-hours", employmentPref: "any" });
    const res = await PUT(
      putRequest({
        baseCountry: "MY", relocation: "open", scheduleFlex: "any-hours", employmentPref: "any",
        displayLocation: null, targetRole: null, salaryMin: null, salaryMax: null, salaryCurrency: null, salaryCadence: null,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Profile.parse(body).relocation).toBe("open");

    const rows = await state.testDb.select().from(profile);
    expect(rows).toHaveLength(1); // upsert, not a duplicate insert
  });

  it("PUT flips scheduleFlex and returns it on the updated Profile", async () => {
    await state.testDb.insert(profile).values({ id: "default", userId: BOOTSTRAP_ADMIN_ID, baseCountry: "MY", relocation: "stay", scheduleFlex: "any-hours", employmentPref: "any" });
    const res = await PUT(
      putRequest({
        baseCountry: "MY", relocation: "stay", scheduleFlex: "base-hours", employmentPref: "any",
        displayLocation: null, targetRole: null, salaryMin: null, salaryMax: null, salaryCurrency: null, salaryCadence: null,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Profile.parse(body).scheduleFlex).toBe("base-hours");
  });

  it("PUT 422s on an invalid body", async () => {
    await state.testDb.insert(profile).values({ id: "default", userId: BOOTSTRAP_ADMIN_ID, baseCountry: "MY", relocation: "stay", scheduleFlex: "any-hours", employmentPref: "any" });
    const res = await PUT(putRequest({ baseCountry: "Malaysia", relocation: "maybe" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("PUT 422s when a salary amount is set without a currency", async () => {
    const res = await PUT(
      putRequest({
        baseCountry: "MY", relocation: "stay", scheduleFlex: "base-hours", employmentPref: "any",
        displayLocation: null, targetRole: null,
        salaryMin: 8000, salaryMax: 12000, salaryCurrency: null, salaryCadence: "monthly",
      }),
    );
    expect(res.status).toBe(422);
  });

  it("PUT round-trips the attribute fields", async () => {
    const res = await PUT(
      putRequest({
        baseCountry: "MY", relocation: "stay", scheduleFlex: "base-hours", employmentPref: "any",
        displayLocation: "Kuala Lumpur, Malaysia", targetRole: "Backend Engineer",
        salaryMin: 8000, salaryMax: 12000, salaryCurrency: "MYR", salaryCadence: "monthly",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.targetRole).toBe("Backend Engineer");
    expect(body.salaryCurrency).toBe("MYR");
  });

  it("a second user's PUT does not affect the first user's row (cross-tenant isolation)", async () => {
    const [userB] = await state.testDb
      .insert(users)
      .values({ email: "user-b-profile-route@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();

    await state.testDb.insert(profile).values({ id: "default", userId: BOOTSTRAP_ADMIN_ID, baseCountry: "MY", relocation: "stay", scheduleFlex: "any-hours", employmentPref: "any" });

    requireUser.mockResolvedValue({ id: userB.id, email: userB.email, role: "user" });
    const res = await PUT(
      putRequest({
        baseCountry: "SG", relocation: "open", scheduleFlex: "any-hours", employmentPref: "any",
        displayLocation: null, targetRole: null, salaryMin: null, salaryMax: null, salaryCurrency: null, salaryCadence: null,
      }),
    );
    expect(res.status).toBe(200);

    requireUser.mockResolvedValue({ id: BOOTSTRAP_ADMIN_ID, email: "admin@example.com", role: "admin" });
    const adminRes = await GET();
    const adminBody = await adminRes.json();
    expect(adminBody.baseCountry).toBe("MY"); // unaffected by userB's PUT
  });
});
