import { describe, expect, it, vi, afterEach } from "vitest";
import { getAdminUsers } from "./client";

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
