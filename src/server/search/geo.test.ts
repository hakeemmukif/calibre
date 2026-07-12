import { describe, expect, it } from "vitest";
import { parseLocationGeo, parseSourceGeo, SourceGeoConfigError } from "./geo";

describe("parseLocationGeo", () => {
  const table: [string | undefined, ReturnType<typeof parseLocationGeo>][] = [
    [undefined, {}],
    ["", {}],
    ["Remote", { workMode: "remote" }],
    ["Remote - US", { workMode: "remote", countryCode: "US" }],
    ["Remote — APAC", { workMode: "remote", regionHint: "APAC" }],
    ["Remote - Anywhere", { workMode: "remote", regionHint: "worldwide" }],
    ["Worldwide", { regionHint: "worldwide" }],
    ["Kuala Lumpur", { countryCode: "MY" }],
    ["Kuala Lumpur, Malaysia", { countryCode: "MY" }],
    ["Selangor", { countryCode: "MY" }],
    ["Petaling Jaya / Kuala Lumpur", { countryCode: "MY" }],
    ["Singapore", { countryCode: "SG" }],
    ["San Francisco / Remote", { workMode: "remote", countryCode: "US" }],
    ["New York, NY", { countryCode: "US" }],
    ["London, United Kingdom", { countryCode: "GB" }],
    ["Hybrid - Kuala Lumpur", { workMode: "hybrid", countryCode: "MY" }],
    ["Onsite, Berlin, Germany", { workMode: "onsite", countryCode: "DE" }],
    ["Remote - Southeast Asia", { workMode: "remote", regionHint: "SEA" }],
    ["Europe (Remote)", { workMode: "remote", regionHint: "EMEA" }],
    ["Klang Valley", { countryCode: "MY" }],
    ["Some Unrecognized Town", {}],
  ];

  it.each(table)("%j -> %j", (input, expected) => {
    expect(parseLocationGeo(input)).toEqual(expected);
  });
});

describe("parseSourceGeo", () => {
  it("board with config.country returns { country }", () => {
    expect(parseSourceGeo({ id: "jobstreet", kind: "board", config: { country: "MY" } })).toEqual({ country: "MY" });
  });

  it("board without config.country throws", () => {
    expect(() => parseSourceGeo({ id: "jobstreet", kind: "board", config: {} })).toThrow(SourceGeoConfigError);
  });

  it("manual with empty config returns {}", () => {
    expect(parseSourceGeo({ id: "manual", kind: "manual", config: {} })).toEqual({});
  });

  it("ats with scope anywhere returns { scope }", () => {
    expect(parseSourceGeo({ id: "gh-gitlab", kind: "ats", config: { geo: { scope: "anywhere" } } })).toEqual({
      scope: "anywhere",
    });
  });

  it("ats with scope restricted + regions returns both", () => {
    expect(
      parseSourceGeo({ id: "ashby-airwallex", kind: "ats", config: { geo: { scope: "restricted", regions: ["APAC"] } } }),
    ).toEqual({ scope: "restricted", regions: ["APAC"] });
  });

  it("ats without geo annotation throws", () => {
    expect(() => parseSourceGeo({ id: "gh-stripe", kind: "ats", config: { slug: "stripe" } })).toThrow(SourceGeoConfigError);
  });

  it("ats with an invalid scope value throws", () => {
    expect(() => parseSourceGeo({ id: "x", kind: "ats", config: { geo: { scope: "sometimes" } } })).toThrow(
      SourceGeoConfigError,
    );
  });
});
