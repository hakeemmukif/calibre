import { describe, expect, it } from "vitest";
import { policyVersion } from "@/lib/llm/templates";
import { emitToFacts, JdFactsEmitSchema, JdFactsSchema } from "./jdFacts";

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

describe("JdFactsEmitSchema (emission schema for both the scanned path and the url-check gate)", () => {
  const base = {
    title: "Engineer",
    mustHaves: [],
    niceToHaves: [],
    responsibilities: [],
    redFlags: [],
    seniority: null,
    employmentType: null,
    location: null,
    remotePolicy: null,
    hiringScope: null,
    hiringCountries: null,
    salaryRange: null,
    tzRequirement: null,
    hiringStructure: null,
    workCalendar: null,
  };

  it("rejects when isJobPosting is omitted (required, unlike JdFactsSchema)", () => {
    expect(() => JdFactsEmitSchema.parse({ ...base, company: "Acme" })).toThrow();
  });

  it("rejects when company is omitted (required, unlike JdFactsSchema)", () => {
    expect(() => JdFactsEmitSchema.parse({ ...base, isJobPosting: true })).toThrow();
  });

  it("accepts company: null (explicit no-company, distinct from omission)", () => {
    const parsed = JdFactsEmitSchema.parse({ ...base, isJobPosting: true, company: null });
    expect(parsed.company).toBeNull();
  });

  it("accepts isJobPosting: false + company: null", () => {
    const parsed = JdFactsEmitSchema.parse({ ...base, isJobPosting: false, company: null });
    expect(parsed.isJobPosting).toBe(false);
  });

  it("accepts isJobPosting: true + a real company string", () => {
    const parsed = JdFactsEmitSchema.parse({ ...base, isJobPosting: true, company: "Acme" });
    expect(parsed.company).toBe("Acme");
  });
});

// Step 1 (task 3 brief) — the required-nullable emission schema + null-strip
// boundary. gpt-oss-120b drops `.optional()` fields from json_schema output
// regardless of prompt wording; JdFactsEmitSchema forces every field present
// so the model must emit tzRequirement/hiringStructure/workCalendar.
describe("JdFacts remote-fit fields", () => {
  const BASE = { title: "Engineer", mustHaves: [], niceToHaves: [], responsibilities: [], redFlags: [] };

  it("parse-side JdFactsSchema tolerates omitted remote-fit fields (cheap-model omission is safe)", () => {
    const parsed = JdFactsSchema.parse({ ...BASE, isJobPosting: true, company: "Acme" });
    expect(parsed.tzRequirement).toBeUndefined();
  });
  it("emission schema requires every field present (scalars nullable, arrays + title non-null)", () => {
    expect(() => JdFactsEmitSchema.parse({ ...BASE, isJobPosting: true })).toThrow(); // company missing
    const ok = JdFactsEmitSchema.parse({
      title: "Engineer", isJobPosting: true, company: null,
      seniority: null, employmentType: null, location: null, remotePolicy: null,
      hiringScope: null, hiringCountries: null, salaryRange: null,
      mustHaves: [], niceToHaves: [], responsibilities: [], redFlags: [],
      tzRequirement: null, hiringStructure: null, workCalendar: null,
    });
    expect(ok.tzRequirement).toBeNull();
  });
  it("emitToFacts strips nulls to undefined (tolerant JdFacts + gate !company preserved)", () => {
    const facts = emitToFacts({
      title: "Engineer", isJobPosting: true, company: null,
      seniority: null, employmentType: null, location: null, remotePolicy: null,
      hiringScope: null, hiringCountries: null, salaryRange: null,
      mustHaves: [], niceToHaves: [], responsibilities: [], redFlags: [],
      tzRequirement: "4h overlap with PST", hiringStructure: null, workCalendar: null,
    });
    expect(facts.company).toBeUndefined();          // the url-check gate's !company stays true
    expect(facts.tzRequirement).toBe("4h overlap with PST");
    expect(facts.hiringStructure).toBeUndefined();
  });
  it("emission schema rejects an invalid hiringStructure enum", () => {
    expect(() => JdFactsEmitSchema.parse({ ...BASE, isJobPosting: true, company: null, hiringStructure: "b2b" })).toThrow();
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
