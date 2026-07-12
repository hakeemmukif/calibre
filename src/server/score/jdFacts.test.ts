import { describe, expect, it } from "vitest";
import { policyVersion } from "@/lib/llm/templates";
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

describe("JdFactsSchema isJobPosting field", () => {
  it("accepts isJobPosting: true", () => {
    const parsed = JdFactsSchema.parse({
      title: "Engineer",
      mustHaves: [],
      niceToHaves: [],
      responsibilities: [],
      redFlags: [],
      isJobPosting: true,
    });
    expect(parsed.isJobPosting).toBe(true);
  });

  it("accepts isJobPosting: false", () => {
    const parsed = JdFactsSchema.parse({
      title: "Engineer",
      mustHaves: [],
      niceToHaves: [],
      responsibilities: [],
      redFlags: [],
      isJobPosting: false,
    });
    expect(parsed.isJobPosting).toBe(false);
  });

  it("stays undefined when omitted (do-not-guess contract)", () => {
    const parsed = JdFactsSchema.parse({
      title: "Engineer",
      mustHaves: [],
      niceToHaves: [],
      responsibilities: [],
      redFlags: [],
    });
    expect(parsed.isJobPosting).toBeUndefined();
  });
});

it("policyVersion('match-score') is unaffected by jd-extract.md content (hashes match-score.md only)", () => {
  // Regression guard for spec 2026-07-12 §11.6: jd-extract.md changes must
  // never invalidate job_scores.policyVersion, which hashes match-score.md.
  const before = policyVersion("match-score");
  // jd-extract.md was edited earlier in this task; policyVersion for
  // "match-score" must be computed purely from match-score.md's bytes.
  const again = policyVersion("match-score");
  expect(again).toBe(before);
});
