import { describe, expect, it, vi } from "vitest";
import { hiddenBandsFor, hiddenStructuresFor, resolveTzBand, tzBandForToken } from "./tzBand";

describe("resolveTzBand token table (spec 2026-07-14 §5)", () => {
  it.each([
    ["4h overlap with PST", "americas"],
    ["EU working hours", "emea"],
    ["APAC hours", "apac"],
    ["Remote (EST hours)", "americas"],
    ["SGT business hours", "apac"],
  ])("maps %s → %s", (tz, band) => {
    expect(resolveTzBand({ tzRequirement: tz })?.band).toBe(band);
  });
  it("bare CST is ambiguous → null + logs", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveTzBand({ tzRequirement: "CST hours" })).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
  it("unmapped token → null + logs (curated-map drift)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveTzBand({ tzRequirement: "Mars Standard Time" })).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
  it("tzRequirement wins over location", () => {
    expect(resolveTzBand({ tzRequirement: "PST overlap", location: "Remote (EU hours)" })?.band).toBe("americas");
  });
  it("nothing stated → null, no log", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveTzBand({})).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
  it("PT/ET are not banded — dropped to avoid ISO country-code collisions", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // location fallback: a Portugal/Ethiopia location must NOT mis-band to americas
    expect(resolveTzBand({ location: "Lisbon, PT" })).toBeNull();
    expect(resolveTzBand({ location: "Addis Ababa, ET" })).toBeNull();
    // even stated, the bare tokens no longer band (removed entirely)
    expect(resolveTzBand({ tzRequirement: "PT" })).toBeNull();
    // a real, unambiguous zone abbreviation still bands from a location string
    expect(resolveTzBand({ location: "Remote (PST)" })?.band).toBe("americas");
    warn.mockRestore();
  });
});

describe("tzBandForToken (Task 9 legacy hiringCountries migration scan)", () => {
  it("maps a TZ token to its band, silently", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(tzBandForToken("4h overlap with PST")).toBe("americas");
    expect(warn).not.toHaveBeenCalled();
  });
  it("an ordinary country name (not a TZ statement) is null, no warning — unlike resolveTzBand", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(tzBandForToken("United States")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
  it("ambiguous CST is null, no warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(tzBandForToken("CST hours")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("gate resolution", () => {
  it("hiddenBandsFor is derived from the ordered dial", () => {
    expect(hiddenBandsFor("base-hours").sort()).toEqual(["americas", "emea"]);
    expect(hiddenBandsFor("flex-evenings")).toEqual(["americas"]);
    expect(hiddenBandsFor("any-hours")).toEqual([]);
  });
  it("hiddenStructuresFor matches the admit rules", () => {
    expect(hiddenStructuresFor("any")).toEqual([]);
    expect(hiddenStructuresFor("employee")).toEqual(["contractor"]);
    expect(hiddenStructuresFor("local-entity").sort()).toEqual(["contractor", "eor"]);
  });
});
