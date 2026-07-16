import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { usersRepo, sessionsRepo, getSession } = vi.hoisted(() => ({
  usersRepo: { create: vi.fn(), findByEmail: vi.fn() },
  sessionsRepo: { create: vi.fn(), deleteByTokenHash: vi.fn(), findUserByTokenHash: vi.fn() },
  getSession: vi.fn(),
}));
vi.mock("@/server/persistence/repos/users", () => ({ usersRepo }));
vi.mock("@/server/persistence/repos/sessions", () => ({ sessionsRepo }));
vi.mock("@/server/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/server/auth/session")>()),
  getSession: () => getSession(),
}));

import { POST as register } from "./register/route";
import { POST as login } from "./login/route";
import { POST as logout } from "./logout/route";
import { GET as session } from "./session/route";
import { hashPassword } from "@/server/auth/password";
import { hashToken } from "@/server/auth/token";
import { SESSION_COOKIE } from "@/server/auth/session";
import { __resetRegisterLimitForTests } from "@/server/auth/registerLimit";

function jsonRequest(body: unknown, headers?: Record<string, string>): Request {
  return new Request("http://x/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CALIBER_INVITE_CODE = "e2e-invite";
  __resetRegisterLimitForTests();
});

afterEach(() => {
  delete process.env.CALIBER_INVITE_CODE;
});

describe("POST /api/auth/register", () => {
  it("creates a 'user'-role account, auto-logs-in, sets an httpOnly cookie", async () => {
    usersRepo.findByEmail.mockResolvedValue(null);
    usersRepo.create.mockResolvedValue({ id: "u1", email: "a@b.co", role: "user" });
    sessionsRepo.create.mockResolvedValue(undefined);
    const res = await register(
      jsonRequest({ email: "a@b.co", password: "longenough", inviteCode: "e2e-invite" }),
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
      jsonRequest({ email: "a@b.co", password: "longenough", inviteCode: "e2e-invite" }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
  });

  it("maps an invalid body to 422 VALIDATION_ERROR", async () => {
    const res = await register(
      jsonRequest({ email: "not-an-email", password: "short" }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    expect(usersRepo.create).not.toHaveBeenCalled();
  });

  it("403s FORBIDDEN on wrong invite code, creating nothing", async () => {
    const res = await register(
      jsonRequest({ email: "a@x.co", password: "hunter2hunter2", inviteCode: "wrong" }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
    expect(usersRepo.create).not.toHaveBeenCalled();
  });

  it("422s when inviteCode is missing entirely", async () => {
    const res = await register(
      jsonRequest({ email: "a@x.co", password: "hunter2hunter2" }),
    );
    expect(res.status).toBe(422);
  });

  it("429s RATE_LIMITED on the 4th registration from one IP inside an hour", async () => {
    usersRepo.create.mockResolvedValue({ id: "u1", email: "a@b.co", role: "user" });
    sessionsRepo.create.mockResolvedValue(undefined);
    for (let i = 0; i < 3; i++) {
      const res = await register(
        jsonRequest(
          { email: `u${i}@x.co`, password: "hunter2hunter2", inviteCode: "e2e-invite" },
          { "x-forwarded-for": "203.0.113.9" },
        ),
      );
      expect(res.status).toBe(201);
    }
    const res = await register(
      jsonRequest(
        { email: "u3@x.co", password: "hunter2hunter2", inviteCode: "e2e-invite" },
        { "x-forwarded-for": "203.0.113.9" },
      ),
    );
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("RATE_LIMITED");
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

describe("GET /api/auth/session", () => {
  it("returns 200 with the user when a session exists", async () => {
    getSession.mockResolvedValue({ id: "u1", email: "a@b.co", role: "user" });
    const res = await session();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: { id: "u1", email: "a@b.co", role: "user" } });
  });

  it("returns 401 UNAUTHORIZED when there is no session", async () => {
    getSession.mockResolvedValue(null);
    const res = await session();
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });
});
