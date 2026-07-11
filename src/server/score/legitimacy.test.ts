import { describe, expect, it } from "vitest";
import type { LegitimacyTier } from "@/types";
import { legitimacyTone, resolveLegitimacyTier } from "./legitimacy";

describe("legitimacyTone", () => {
  const table: [LegitimacyTier, string][] = [
    ["verified", "verified"],
    ["clear", "good"],
    ["suspicious", "warn"],
    ["ghost", "ghost"],
    ["scam", "danger"],
  ];

  it.each(table)("%s -> %s", (tier, tone) => {
    expect(legitimacyTone(tier)).toBe(tone);
  });
});

describe("resolveLegitimacyTier", () => {
  it("clear + active liveness -> clear", () => {
    expect(resolveLegitimacyTier({ tier: "clear", liveness: "active" })).toBe("clear");
  });

  it("verified + corroborated -> verified", () => {
    expect(resolveLegitimacyTier({ tier: "verified", liveness: "active", corroborated: true })).toBe("verified");
  });

  it("verified without corroboration is downgraded to clear", () => {
    expect(resolveLegitimacyTier({ tier: "verified", liveness: "active", corroborated: false })).toBe("clear");
    expect(resolveLegitimacyTier({ tier: "verified", liveness: "active" })).toBe("clear");
  });

  it("suspicious passes through unchanged", () => {
    expect(resolveLegitimacyTier({ tier: "suspicious", liveness: "active" })).toBe("suspicious");
  });

  it("expired liveness overrides a good model tier -> ghost", () => {
    expect(resolveLegitimacyTier({ tier: "clear", liveness: "expired" })).toBe("ghost");
  });

  it("model scam tier -> scam even when liveness is active", () => {
    expect(resolveLegitimacyTier({ tier: "scam", liveness: "active" })).toBe("scam");
  });

  it("scam wins over expired liveness too", () => {
    expect(resolveLegitimacyTier({ tier: "scam", liveness: "expired" })).toBe("scam");
  });

  it("uncertain liveness does not itself force ghost", () => {
    expect(resolveLegitimacyTier({ tier: "clear", liveness: "uncertain" })).toBe("clear");
  });
});
