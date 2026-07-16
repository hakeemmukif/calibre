import { describe, expect, it, vi, afterEach } from "vitest";
import { getAdminUsers, grantCredits, patchUserPlan } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
});

const ADMIN_USER = {
  id: "u1",
  email: "admin@caliber.dev",
  role: "admin" as const,
  createdAt: "2026-01-05T09:00:00.000Z",
  resumeCount: 1,
  jobCount: 4,
  applicationCount: 2,
  balance: 20,
  plan: "standard" as const,
};

describe("getAdminUsers", () => {
  it("GETs /api/admin/users and returns the parsed items array", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [ADMIN_USER] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const users = await getAdminUsers();

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/users", undefined);
    expect(users).toEqual([ADMIN_USER]);
  });

  it("throws an ApiError with status 403 when the API forbids the request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "FORBIDDEN", message: "Admins only." } }),
        { status: 403 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getAdminUsers()).rejects.toMatchObject({ status: 403 });
  });
});

describe("patchUserPlan", () => {
  it("PATCHes /api/admin/users/:id with the new plan and returns the parsed AdminUser", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...ADMIN_USER, plan: "unlimited" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const updated = await patchUserPlan("u1", "unlimited");

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/users/u1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan: "unlimited" }),
    });
    expect(updated.plan).toBe("unlimited");
  });
});

describe("grantCredits", () => {
  it("POSTs /api/admin/users/:id/credits with the delta and returns the new balance", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ balance: 170 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const balance = await grantCredits("u1", 150);

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/users/u1/credits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delta: 150 }),
    });
    expect(balance).toBe(170);
  });
});
