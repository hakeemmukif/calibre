import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mintSessionToken, hashToken } from "./token";

describe("session tokens", () => {
  it("mints a raw token whose stored hash is its SHA-256 (hex)", () => {
    const { raw, hash } = mintSessionToken();
    expect(raw.length).toBeGreaterThanOrEqual(32);
    expect(hash).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(hash).not.toBe(raw); // raw never equals what we store
  });

  it("hashToken is deterministic and matches mint", () => {
    const { raw, hash } = mintSessionToken();
    expect(hashToken(raw)).toBe(hash);
  });

  it("successive mints differ", () => {
    expect(mintSessionToken().raw).not.toBe(mintSessionToken().raw);
  });
});
