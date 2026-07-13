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
  // Trust-killer guard (spec §14.2): a bare 2-letter country code in a LOCATION
  // string must never map to a band. "PT"/"ET" are stated-source-only tokens.
  it("bare country code PT in a location string does NOT map (Lisbon, PT)", () => {
    expect(resolveTzBand({ location: "Lisbon, PT" })).toBeNull();
  });
  it("nothing stated -> null (no guess, no log)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveTzBand({})).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("probeTzToken (non-logging, for recompute scavenge)", () => {
  it("returns a band without logging, and null for ordinary country names", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(probeTzToken("PST", "stated")).toBe("americas");
    expect(probeTzToken("United States", "stated")).toBeNull(); // ordinary country name -> no band, no log
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
