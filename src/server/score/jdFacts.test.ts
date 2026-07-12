import { describe, expect, it } from "vitest";
import { JdFactsSchema } from "./jdFacts";

describe("JdFactsSchema hiring-scope fields", () => {
  it("accepts hiringScope + hiringCountries when stated", () => {
    const parsed = JdFactsSchema.parse({
      title: "Engineer",
      mustHaves: [],
      niceToHaves: [],
      responsibilities: [],
      redFlags: [],
      hiringScope: "restricted",
      hiringCountries: ["APAC", "Singapore"],
    });
    expect(parsed.hiringScope).toBe("restricted");
    expect(parsed.hiringCountries).toEqual(["APAC", "Singapore"]);
  });

  it("both fields stay absent when unstated (do-not-guess contract)", () => {
    const parsed = JdFactsSchema.parse({
      title: "Engineer",
      mustHaves: [],
      niceToHaves: [],
      responsibilities: [],
      redFlags: [],
    });
    expect(parsed.hiringScope).toBeUndefined();
    expect(parsed.hiringCountries).toBeUndefined();
  });

  it("rejects an invalid hiringScope value", () => {
    expect(() =>
      JdFactsSchema.parse({
        title: "E",
        mustHaves: [],
        niceToHaves: [],
        responsibilities: [],
        redFlags: [],
        hiringScope: "sometimes",
      }),
    ).toThrow();
  });
});
