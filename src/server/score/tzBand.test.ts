import { describe, expect, it, vi } from "vitest";
import { resolveTzBand, probeTzToken, allowedBandsFor, allowedStructuresFor } from "./tzBand";

describe("resolveTzBand token table", () => {
  const cases: [string, "apac" | "emea" | "americas"][] = [
    ["4h overlap with PST", "americas"], ["US working hours", "americas"], ["North America", "americas"],
    ["CET", "emea"], ["EU working hours", "emea"], ["GMT/BST", "emea"],
    ["SGT", "apac"], ["APAC hours", "apac"], ["AEST", "apac"],
  ];
  it.each(cases)("statedTz %s -> %s", (statedTz, band) => {
    expect(resolveTzBand({ statedTz })!.band).toBe(band);
  });
  it("bare CST is ambiguous (US Central vs China) -> null + warn (never a band)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveTzBand({ statedTz: "CST" })).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
  it("bare IST is ambiguous (India/Israel/Ireland) -> null", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveTzBand({ statedTz: "IST" })).toBeNull();
    warn.mockRestore();
  });
  it("unmapped stated token -> null + warn (curated-map drift signal)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveTzBand({ statedTz: "Klingon Standard Time" })).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
  it("statedTz (authority) wins over location", () => {
    expect(resolveTzBand({ statedTz: "PST", location: "Remote (CET)" })!.band).toBe("americas");
  });
  it("falls back to a location token when statedTz absent", () => {
    expect(resolveTzBand({ location: "Remote — EST hours" })!.band).toBe("americas");
  });
  // Trust-killer guard (spec §14.2), preserved: a bare 2-letter code in a
  // LOCATION string still never maps on its own. "PT"/"ET" are stated-only.
  it("bare country code PT alone in a location does NOT map", () => {
    expect(resolveTzBand({ location: "Remote, PT" })).toBeNull();
  });
  // But an unambiguous CITY name in the same string now resolves from the city,
  // not the code: "Lisbon" -> emea (PT is still never read as Pacific).
  it("a city name in a location resolves (Lisbon, PT -> emea via the city)", () => {
    expect(resolveTzBand({ location: "Lisbon, PT" })!.band).toBe("emea");
  });
  it.each([
    ["Kuala Lumpur, Malaysia", "apac"],
    ["Selangor", "apac"],
    ["Bengaluru", "apac"],
    ["Remote — Shanghai", "apac"],
    ["São Paulo, Brazil", "americas"],
    ["Buenos Aires", "americas"],
    ["United States", "americas"],
    ["London, United Kingdom", "emea"],
    // Hyphen-joined multi-word place names (job-board idiom "Remote-<Country>") —
    // the join separator between words must tolerate "-" as well as whitespace.
    ["Remote-United-States", "americas"],
    ["Remote-United-Kingdom", "emea"],
    // Bare country code, anchored to the "Remote[-/in] <CODE>" idiom only —
    // never a bare 2-letter code on its own (§14.2 trust-killer stays intact).
    ["Remote-US", "americas"],
    ["Remote - US", "americas"],
    ["Remote in UK", "emea"],
    ["Korea", "apac"],
    ["Riyadh", "emea"],
    ["Middle East", "emea"],
    ["Paris", "emea"],
    // US state abbreviation, comma-anchored ("City, ST") — never a bare token.
    ["Philadelphia, PA", "americas"],
    ["Dallas, TX", "americas"],
    ["Broomfield, CO", "americas"],
    ["Detroit, MI", "americas"],
    ["Irving, TX", "americas"],
  ] as [string, "apac" | "emea" | "americas"][])("location %s -> %s", (location, band) => {
    expect(resolveTzBand({ location })!.band).toBe(band);
  });
  // Worldwide/anywhere-band policy is out of scope here (decided separately) —
  // these must stay unclassified, not silently fold into a band.
  it.each(["Remote", "Remote - Anywhere", "Anywhere", "Global", "Globally", "Global Anywhere", "Remote Role", "Tier 2"])(
    "worldwide/vague location %s stays unclassified (null)",
    (location) => {
      expect(resolveTzBand({ location })).toBeNull();
    },
  );
  // Homonyms are deliberately excluded, and \b anchors prevent substring leaks.
  it.each(["Georgia", "Perth", "Indiana"])("ambiguous / substring-trap location %s does NOT mis-map", (location) => {
    expect(resolveTzBand({ location })).toBeNull();
  });
  it.each([
    // Resolves via "San Francisco" -> americas, never apac via a "China" substring.
    ["Chinatown, San Francisco County", "americas"],
    // The comma-anchored state code disambiguates what the bare city name
    // (deliberately excluded — Athens GR/US) alone could not.
    ["Athens, GA", "americas"],
  ] as [string, "apac" | "emea" | "americas"][])("substring/comma-disambiguated location %s -> %s", (location, band) => {
    expect(resolveTzBand({ location })!.band).toBe(band);
  });
  it("nothing stated -> null (no guess, no log)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveTzBand({})).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("probeTzToken (non-logging, for recompute scavenge)", () => {
  it("returns a band without logging, and maps unambiguous country names silently", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(probeTzToken("PST", "stated")).toBe("americas");
    // Country names now map (completes the recompute hiringCountries scavenge),
    // and must still do so WITHOUT logging — the scavenge calls this per entry.
    expect(probeTzToken("United States", "location")).toBe("americas");
    expect(probeTzToken("Malaysia", "location")).toBe("apac");
    expect(probeTzToken("Narnia", "location")).toBeNull(); // unknown place -> no band, no log
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("gate mappings", () => {
  it("allowedBandsFor: base-hours admits only apac; flex-evenings apac+emea; any-hours all (null)", () => {
    expect(allowedBandsFor("base-hours")).toEqual(["apac"]);
    expect(allowedBandsFor("flex-evenings")).toEqual(["apac", "emea"]);
    expect(allowedBandsFor("any-hours")).toBeNull();
  });
  it("allowedStructuresFor: employee admits local-entity+eor; local-entity admits only itself; any -> null", () => {
    expect(allowedStructuresFor("employee")).toEqual(["local-entity", "eor"]);
    expect(allowedStructuresFor("local-entity")).toEqual(["local-entity"]);
    expect(allowedStructuresFor("any")).toBeNull();
  });
});
