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
  ] as [string, "apac" | "emea" | "americas"][])("location %s -> %s", (location, band) => {
    expect(resolveTzBand({ location })!.band).toBe(band);
  });
  // Homonyms are deliberately excluded, and \b anchors prevent substring leaks.
  it.each(["Georgia", "Perth", "Athens, GA", "Indiana", "Chinatown, San Francisco County"])(
    "ambiguous / substring-trap location %s does NOT mis-map",
    (location) => {
      // Chinatown case still resolves via "San Francisco" -> americas, never
      // apac via a "China" substring; the others map to null.
      const res = resolveTzBand({ location });
      if (location.includes("San Francisco")) expect(res!.band).toBe("americas");
      else expect(res).toBeNull();
    },
  );
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
