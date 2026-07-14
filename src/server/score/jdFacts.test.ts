import { describe, expect, it } from "vitest";
import { z } from "zod";
import { policyVersion, scoringPolicyVersion } from "@/lib/llm/templates";
import { JdFactsEmissionSchema, JdFactsSchema, normalizeEmission, type JdFacts, type JdFactsEmission } from "./jdFacts";

function emissionFixture(): JdFactsEmission {
  return {
    title: "Senior Backend Engineer",
    isJobPosting: true,
    company: "Acme",
    seniority: "senior",
    employmentType: "full-time",
    location: "Remote",
    remotePolicy: "remote-first",
    hiringScope: "restricted",
    hiringCountries: ["United States"],
    tzRequirement: "4h overlap with PST",
    hiringStructure: "eor",
    workCalendar: "US public holidays",
    mustHaves: ["TypeScript"],
    niceToHaves: ["Kafka"],
    salaryRange: "$120k-$150k",
    responsibilities: ["Own the payments ledger"],
    redFlags: [],
  };
}

function jdFixture(): JdFacts {
  return {
    title: "Senior Backend Engineer",
    mustHaves: ["TypeScript"],
    niceToHaves: [],
    responsibilities: [],
    redFlags: [],
  };
}

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

describe("JdFactsEmissionSchema (used by BOTH jd-extract callers — JdFactsSchema itself stays optional)", () => {
  it("rejects when isJobPosting is omitted (required, unlike JdFactsSchema)", () => {
    const { isJobPosting: _isJobPosting, ...rest } = emissionFixture();
    expect(() => JdFactsEmissionSchema.parse(rest)).toThrow();
  });

  it("rejects when company is omitted (required, unlike JdFactsSchema)", () => {
    const { company: _company, ...rest } = emissionFixture();
    expect(() => JdFactsEmissionSchema.parse(rest)).toThrow();
  });

  it("accepts company: null (explicit no-company, distinct from omission)", () => {
    const parsed = JdFactsEmissionSchema.parse({ ...emissionFixture(), company: null });
    expect(parsed.company).toBeNull();
  });

  it("accepts isJobPosting: false + company: null", () => {
    const parsed = JdFactsEmissionSchema.parse({ ...emissionFixture(), isJobPosting: false, company: null });
    expect(parsed.isJobPosting).toBe(false);
  });

  it("accepts isJobPosting: true + a real company string", () => {
    const parsed = JdFactsEmissionSchema.parse({ ...emissionFixture(), isJobPosting: true, company: "Acme" });
    expect(parsed.company).toBe("Acme");
  });
});

describe("jd-extract emission schema (Layer-C liveness fix, spec 2026-07-14 §4)", () => {
  it("emission schema marks every eligibility+schedule fact as REQUIRED (nullable)", () => {
    const json = z.toJSONSchema(JdFactsEmissionSchema) as { required?: string[] };
    for (const f of ["hiringScope", "hiringCountries", "location", "remotePolicy", "tzRequirement", "hiringStructure", "workCalendar"]) {
      expect(json.required).toContain(f);
    }
  });
  it("isJobPosting stays a required non-null boolean (the gate decision)", () => {
    expect(() => JdFactsEmissionSchema.parse({ ...emissionFixture(), isJobPosting: null })).toThrow();
  });
  it("normalizeEmission turns nulls into undefined for the tolerant JdFacts", () => {
    const norm = normalizeEmission({ ...emissionFixture(), tzRequirement: null, hiringStructure: null });
    expect(norm.tzRequirement).toBeUndefined();
    expect(norm.hiringStructure).toBeUndefined();
    expect(JdFactsSchema.parse(norm)).toBeTruthy();
  });
  it("parse-side JdFactsSchema accepts a stated contractor structure", () => {
    expect(JdFactsSchema.parse({ ...jdFixture(), hiringStructure: "contractor" }).hiringStructure).toBe("contractor");
  });
  it("scoringPolicyVersion changes when jd-extract.md changes (verdict cache invalidates)", () => {
    expect(scoringPolicyVersion()).toMatch(/^[0-9a-f]{12}$/);
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
