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
  it("High Confidence + active liveness -> clear", () => {
    expect(resolveLegitimacyTier({ donorTier: "High Confidence", liveness: "active" })).toBe("clear");
  });

  it("High Confidence + corroborated -> verified", () => {
    expect(resolveLegitimacyTier({ donorTier: "High Confidence", liveness: "active", corroborated: true })).toBe(
      "verified",
    );
  });

  it("Caution -> suspicious", () => {
    expect(resolveLegitimacyTier({ donorTier: "Caution", liveness: "active" })).toBe("suspicious");
  });

  it("Suspicious -> suspicious", () => {
    expect(resolveLegitimacyTier({ donorTier: "Suspicious", liveness: "active" })).toBe("suspicious");
  });

  it("expired liveness overrides a good donor tier -> ghost", () => {
    expect(resolveLegitimacyTier({ donorTier: "High Confidence", liveness: "expired" })).toBe("ghost");
  });

  it("Scam donor tier -> scam even when liveness is active", () => {
    expect(resolveLegitimacyTier({ donorTier: "Scam", liveness: "active" })).toBe("scam");
  });

  it("Scam wins over expired liveness too", () => {
    expect(resolveLegitimacyTier({ donorTier: "Scam", liveness: "expired" })).toBe("scam");
  });

  it("uncertain liveness does not itself force ghost", () => {
    expect(resolveLegitimacyTier({ donorTier: "High Confidence", liveness: "uncertain" })).toBe("clear");
  });
});
