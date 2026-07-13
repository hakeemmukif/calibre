import { describe, expect, it, vi, beforeEach } from "vitest";

const findUserByTokenHash = vi.fn();
vi.mock("@/server/persistence/repos/sessions", () => ({
  sessionsRepo: { findUserByTokenHash: (t: string) => findUserByTokenHash(t) },
}));

import { resolveSessionFromToken } from "./session";
import { hashToken } from "./token";

beforeEach(() => findUserByTokenHash.mockReset());

describe("resolveSessionFromToken", () => {
  it("returns null when there is no token", async () => {
    expect(await resolveSessionFromToken(undefined)).toBeNull();
    expect(findUserByTokenHash).not.toHaveBeenCalled();
  });

  it("looks up by the SHA-256 hash of the raw token and returns AuthUser", async () => {
    findUserByTokenHash.mockResolvedValue({ id: "u1", email: "a@b.co", role: "admin", passwordHash: "h", createdAt: new Date() });
    const user = await resolveSessionFromToken("raw-token");
    expect(findUserByTokenHash).toHaveBeenCalledWith(hashToken("raw-token"));
    expect(user).toEqual({ id: "u1", email: "a@b.co", role: "admin" }); // hash stripped
  });

  it("returns null for an unknown token", async () => {
    findUserByTokenHash.mockResolvedValue(null);
    expect(await resolveSessionFromToken("ghost")).toBeNull();
  });
});
