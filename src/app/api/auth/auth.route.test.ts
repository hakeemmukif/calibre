import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { usersRepo, sessionsRepo } = vi.hoisted(() => ({
  usersRepo: { create: vi.fn(), findByEmail: vi.fn() },
  sessionsRepo: { create: vi.fn(), deleteByTokenHash: vi.fn(), findUserByTokenHash: vi.fn() },
}));
vi.mock("@/server/persistence/repos/users", () => ({ usersRepo }));
vi.mock("@/server/persistence/repos/sessions", () => ({ sessionsRepo }));

import { POST as register } from "./register/route";
import { POST as login } from "./login/route";
import { POST as logout } from "./logout/route";
import { hashPassword } from "@/server/auth/password";
import { hashToken } from "@/server/auth/token";
import { SESSION_COOKIE } from "@/server/auth/session";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/auth/register", () => {
  it("creates a 'user'-role account, auto-logs-in, sets an httpOnly cookie", async () => {
    usersRepo.findByEmail.mockResolvedValue(null);
    usersRepo.create.mockResolvedValue({ id: "u1", email: "a@b.co", role: "user" });
    sessionsRepo.create.mockResolvedValue(undefined);
    const res = await register(
      new Request("http://x/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ email: "a@b.co", password: "longenough" }),
      }) as any
    );
    expect(res.status).toBe(201);
    expect(usersRepo.create).toHaveBeenCalledWith(expect.objectContaining({ role: "user" }));
    const body = await res.json();
    expect(body.user).toEqual({ id: "u1", email: "a@b.co", role: "user" });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("caliber_session=");
    expect(cookie.toLowerCase()).toContain("httponly");
  });

  it("maps EmailTakenError to 409 CONFLICT", async () => {
    const { EmailTakenError } = await import("@/server/auth/errors");
    usersRepo.create.mockRejectedValue(new EmailTakenError("a@b.co"));
    const res = await register(
      new Request("http://x/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ email: "a@b.co", password: "longenough" }),
      }) as any
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
  });

  it("maps an invalid body to 422 VALIDATION_ERROR", async () => {
    const res = await register(
      new Request("http://x/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ email: "not-an-email", password: "short" }),
      }) as any
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    expect(usersRepo.create).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/login", () => {
  it("logs in with correct credentials, sets an httpOnly cookie", async () => {
    usersRepo.findByEmail.mockResolvedValue({
      id: "u1",
      email: "a@b.co",
      role: "user",
      passwordHash: await hashPassword("right"),
    });
    sessionsRepo.create.mockResolvedValue(undefined);
    const res = await login(
      new Request("http://x/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "a@b.co", password: "right" }),
      }) as any
    );
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie.toLowerCase()).toContain("httponly");
  });

  it("rejects a wrong password with 401 UNAUTHORIZED", async () => {
    usersRepo.findByEmail.mockResolvedValue({
      id: "u1",
      email: "a@b.co",
      role: "user",
      passwordHash: await hashPassword("right"),
    });
    const res = await login(
      new Request("http://x/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "a@b.co", password: "wrong" }),
      }) as any
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("rejects an unknown email with the identical 401 UNAUTHORIZED error (no user-enumeration)", async () => {
    usersRepo.findByEmail.mockResolvedValue(null);
    const unknownRes = await login(
      new Request("http://x/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "nobody@b.co", password: "whatever" }),
      }) as any
    );
    usersRepo.findByEmail.mockResolvedValue({
      id: "u1",
      email: "a@b.co",
      role: "user",
      passwordHash: await hashPassword("right"),
    });
    const wrongPasswordRes = await login(
      new Request("http://x/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "a@b.co", password: "wrong" }),
      }) as any
    );
    expect(unknownRes.status).toBe(wrongPasswordRes.status);
    expect(await unknownRes.json()).toEqual(await wrongPasswordRes.json());
  });
});

describe("POST /api/auth/logout", () => {
  it("clears sessions and the cookie when a session cookie is present", async () => {
    sessionsRepo.deleteByTokenHash.mockResolvedValue(undefined);
    const req = new NextRequest("http://x/api/auth/logout", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=raw-token` },
    });
    const res = await logout(req);
    expect(res.status).toBe(204);
    expect(sessionsRepo.deleteByTokenHash).toHaveBeenCalledWith(hashToken("raw-token"));
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie.toLowerCase()).toContain("httponly");
  });

  it("is idempotent — no error when already logged out (no cookie)", async () => {
    const req = new NextRequest("http://x/api/auth/logout", { method: "POST" });
    const res = await logout(req);
    expect(res.status).toBe(204);
    expect(sessionsRepo.deleteByTokenHash).not.toHaveBeenCalled();
  });
});

// GET /api/auth/session depends on next/headers `cookies()` request scope,
// which isn't reachable from a unit test outside a request context. It's
// covered by the Task 14 integration smoke instead.
