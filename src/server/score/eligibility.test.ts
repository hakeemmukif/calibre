import { describe, expect, it } from "vitest";
import type { EligibilityTier } from "@/types";
import { eligibilityTone, resolveEligibility } from "./eligibility";

const MY_BOARD = { baseCountry: "MY", sourceKind: "board" as const, sourceGeo: { country: "MY" } };
const ATS_ANYWHERE = { baseCountry: "MY", sourceKind: "ats" as const, sourceGeo: { scope: "anywhere" as const } };
const ATS_RESTRICTED = { baseCountry: "MY", sourceKind: "ats" as const, sourceGeo: { scope: "restricted" as const } };
const ATS_APAC = {
  baseCountry: "MY",
  sourceKind: "ats" as const,
  sourceGeo: { scope: "restricted" as const, regions: ["APAC"] },
};

describe("eligibilityTone", () => {
  const table: [EligibilityTier, string][] = [
    ["anywhere", "verified"],
    ["eligible", "good"],
    ["local", "good"],
    ["abroad", "warn"],
    ["unknown", "warn"],
  ];
  it.each(table)("%s -> %s", (tier, tone) => {
    expect(eligibilityTone(tier)).toBe(tone);
  });
});

describe("resolveEligibility precedence", () => {
  // Layer A — board country stamp beats everything.
  it("MY board -> local, even with a remote-looking location", () => {
    expect(resolveEligibility({ ...MY_BOARD, location: "Remote" }).tier).toBe("local");
  });

  it("foreign board -> abroad", () => {
    expect(
      resolveEligibility({ baseCountry: "MY", sourceKind: "board", sourceGeo: { country: "SG" }, location: "Singapore" })
        .tier,
    ).toBe("abroad");
  });

  // Layer C — JD-stated facts beat connector strings and priors.
  it("JD hires anywhere -> anywhere, even on a restricted source", () => {
    expect(resolveEligibility({ ...ATS_RESTRICTED, location: "Remote", jdFacts: { hiringScope: "anywhere" } }).tier).toBe(
      "anywhere",
    );
  });

  it("JD restricted to APAC -> eligible for MY", () => {
    expect(
      resolveEligibility({ ...ATS_RESTRICTED, jdFacts: { hiringScope: "restricted", hiringCountries: ["APAC"] } }).tier,
    ).toBe("eligible");
  });

  it("JD restricted to United States -> abroad (geo-fenced remote folds into abroad)", () => {
    expect(
      resolveEligibility({
        ...ATS_ANYWHERE,
        location: "Remote",
        jdFacts: { hiringScope: "restricted", hiringCountries: ["United States"] },
      }).tier,
    ).toBe("abroad");
  });

  it("JD restricted with an unmappable term (TZ window) -> unknown, term in evidence", () => {
    const r = resolveEligibility({
      ...ATS_ANYWHERE,
      jdFacts: { hiringScope: "restricted", hiringCountries: ["4h overlap with PST"] },
    });
    expect(r.tier).toBe("unknown");
    expect(r.evidence).toContain("4h overlap with PST");
  });

  it("JD restricted, regions unstated -> unknown", () => {
    expect(resolveEligibility({ ...ATS_ANYWHERE, jdFacts: { hiringScope: "restricted" } }).tier).toBe("unknown");
  });

  // Connector-geo layer.
  it("location worldwide -> anywhere", () => {
    expect(resolveEligibility({ ...ATS_RESTRICTED, location: "Remote - Anywhere" }).tier).toBe("anywhere");
  });

  it("remote + APAC region -> eligible", () => {
    expect(resolveEligibility({ ...ATS_RESTRICTED, location: "Remote — APAC" }).tier).toBe("eligible");
  });

  it("remote + US -> abroad", () => {
    expect(resolveEligibility({ ...ATS_ANYWHERE, location: "Remote - US" }).tier).toBe("abroad");
  });

  it("onsite in MY -> local", () => {
    expect(resolveEligibility({ ...ATS_RESTRICTED, location: "Kuala Lumpur, Malaysia" }).tier).toBe("local");
  });

  it("onsite elsewhere -> abroad", () => {
    expect(resolveEligibility({ ...ATS_ANYWHERE, location: "New York, NY" }).tier).toBe("abroad");
  });

  // Prior layer — only reached by a bare "Remote".
  it("bare Remote + anywhere prior -> anywhere (the single sanctioned prior grant)", () => {
    expect(resolveEligibility({ ...ATS_ANYWHERE, location: "Remote" }).tier).toBe("anywhere");
  });

  it("bare Remote + restricted prior -> unknown (never eligible from a restricted prior alone)", () => {
    expect(resolveEligibility({ ...ATS_RESTRICTED, location: "Remote" }).tier).toBe("unknown");
  });

  it("bare Remote + restricted prior with APAC regions -> eligible (Airwallex case)", () => {
    expect(resolveEligibility({ ...ATS_APAC, location: "Remote" }).tier).toBe("eligible");
  });

  // Structured connector geo MERGES with the parsed location string —
  // partial structured fields must never erase what the string carries.
  it("connectorGeo workMode merges with the string's country (Ashby isRemote + 'Remote (US)')", () => {
    expect(
      resolveEligibility({ ...ATS_RESTRICTED, location: "Remote (US)", connectorGeo: { workMode: "remote" } }).tier,
    ).toBe("abroad");
  });

  it("connectorGeo countryCode overrides the string's parse", () => {
    expect(
      resolveEligibility({ ...ATS_RESTRICTED, location: "Remote", connectorGeo: { workMode: "remote", countryCode: "MY" } })
        .tier,
    ).toBe("eligible");
  });

  // Fail-loud floor.
  it("empty location, no JD facts -> unknown with 'no geography stated'", () => {
    const r = resolveEligibility({ ...ATS_ANYWHERE, location: "" });
    expect(r.tier).toBe("unknown");
    expect(r.evidence).toBe("no geography stated");
  });

  it("every result carries a non-empty evidence string", () => {
    const cases = [
      resolveEligibility({ ...MY_BOARD, location: "Kuala Lumpur" }),
      resolveEligibility({ ...ATS_ANYWHERE, location: "Remote" }),
      resolveEligibility({ ...ATS_RESTRICTED, location: "Remote" }),
      resolveEligibility({ ...ATS_ANYWHERE, location: "New York, NY" }),
    ];
    for (const c of cases) expect(c.evidence.length).toBeGreaterThan(0);
  });
});
