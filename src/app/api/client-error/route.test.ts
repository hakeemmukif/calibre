import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/server/auth/session", () => ({ getSession: () => getSession() }));

import { POST } from "./route";
import { __resetClientErrorLimitForTests } from "@/server/http/clientErrorLimit";

function beaconRequest(body: unknown, headers?: Record<string, string>): Request {
  return new Request("http://x/api/client-error", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const valid = {
  message: "boom",
  stack: "Error: boom\n  at page",
  url: "https://caliber.fightbase.co/feed",
  at: new Date().toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue(null);
  __resetClientErrorLimitForTests();
});

describe("POST /api/client-error", () => {
  it("204s and logs one [client-error] line with userId null when unauthenticated", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(beaconRequest(valid));
    expect(res.status).toBe(204);
    expect(spy).toHaveBeenCalledOnce();
    const [tag, json] = spy.mock.calls[0];
    expect(tag).toBe("[client-error]");
    expect(JSON.parse(json as string)).toMatchObject({ message: "boom", userId: null });
    spy.mockRestore();
  });

  it("attaches userId server-side when a session exists (never client-supplied)", async () => {
    getSession.mockResolvedValue({ id: "u1", email: "a@b.co", role: "user" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await POST(beaconRequest(valid));
    expect(JSON.parse(spy.mock.calls[0][1] as string).userId).toBe("u1");
    spy.mockRestore();
  });

  it("413s a body over the size cap BEFORE parsing", async () => {
    const res = await POST(beaconRequest({ ...valid, stack: "x".repeat(20_000) }));
    expect(res.status).toBe(413);
  });

  it("422s an invalid shape", async () => {
    const res = await POST(beaconRequest({ nope: true }));
    expect(res.status).toBe(422);
  });

  it("429s the 6th report from one IP inside a minute (XFF-keyed)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 5; i++) {
      const res = await POST(beaconRequest(valid, { "x-forwarded-for": "203.0.113.7" }));
      expect(res.status).toBe(204);
    }
    const res = await POST(beaconRequest(valid, { "x-forwarded-for": "203.0.113.7" }));
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("RATE_LIMITED");
    spy.mockRestore();
  });
});
