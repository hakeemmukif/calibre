import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Persona,
  ScanPersona,
  SourceRef,
  Source,
  ErrorCode,
  ErrorEnvelope,
  GhostWebEvidence,
  WebEvidence,
  Legitimacy,
  UrlCheckRequest,
  UrlCheck,
  AuthUser,
  RegisterRequest,
  ScheduleFlex,
  EmploymentPref,
  Profile,
  Resume,
  AdminPoolStats,
} from "./index";

function baseResume(overrides: Partial<z.infer<typeof Resume>> = {}) {
  return {
    id: "r1",
    atsScore: 80,
    updatedAt: "2026-07-11T00:00:00.000Z",
    headline: "Senior Backend Engineer",
    location: "Kuala Lumpur, Malaysia",
    experience: [],
    skills: [],
    projects: [],
    certifications: [],
    languages: [],
    rawText: "raw résumé text",
    ...overrides,
  };
}

describe("Resume.extractionPath", () => {
  it("is optional — a résumé with no extractionPath still parses", () => {
    const resume = Resume.parse(baseResume());
    expect(resume.extractionPath).toBeUndefined();
  });

  it("accepts 'text' and 'vision'", () => {
    expect(Resume.parse(baseResume({ extractionPath: "text" })).extractionPath).toBe("text");
    expect(Resume.parse(baseResume({ extractionPath: "vision" })).extractionPath).toBe("vision");
  });

  it("rejects an unknown extractionPath value", () => {
    expect(() => Resume.parse(baseResume({ extractionPath: "ocr" as "text" }))).toThrow();
  });
});

describe("Persona / ScanPersona", () => {
  it("Persona accepts pasted, remote, local", () => {
    expect(Persona.parse("pasted")).toBe("pasted");
    expect(Persona.parse("remote")).toBe("remote");
    expect(Persona.parse("local")).toBe("local");
  });

  it("Persona rejects unknown values", () => {
    expect(() => Persona.parse("global")).toThrow();
  });

  it("ScanPersona accepts remote/local but rejects pasted", () => {
    expect(ScanPersona.parse("remote")).toBe("remote");
    expect(ScanPersona.parse("local")).toBe("local");
    expect(() => ScanPersona.parse("pasted")).toThrow();
  });
});

describe("SourceRef.kind / Source.kind", () => {
  it("accepts manual alongside ats/board", () => {
    expect(SourceRef.shape.kind.parse("manual")).toBe("manual");
    expect(Source.shape.kind.parse("manual")).toBe("manual");
  });

  it("rejects unknown kind", () => {
    expect(() => SourceRef.shape.kind.parse("rss")).toThrow();
  });
});

describe("ErrorCode / ErrorEnvelope", () => {
  it("accepts all legacy codes plus the two new ones", () => {
    const codes = [
      "VALIDATION_ERROR",
      "NOT_FOUND",
      "CONFLICT",
      "RUN_NOT_READY",
      "PARSE_FAILED",
      "EXTRACTION_FAILED",
      "UPSTREAM_LLM_ERROR",
      "PAYLOAD_TOO_LARGE",
      "FETCH_BLOCKED",
      "NOT_A_JOB_POSTING",
      "INTERNAL",
    ] as const;
    for (const code of codes) {
      expect(ErrorCode.parse(code)).toBe(code);
    }
  });

  it("ErrorEnvelope still parses with an old code (wire shape unchanged)", () => {
    const envelope = ErrorEnvelope.parse({
      error: { code: "CONFLICT", message: "no active resume" },
    });
    expect(envelope.error.code).toBe("CONFLICT");
  });

  it("ErrorEnvelope parses with a new code", () => {
    const envelope = ErrorEnvelope.parse({
      error: { code: "FETCH_BLOCKED", message: "search tier found nothing" },
    });
    expect(envelope.error.code).toBe("FETCH_BLOCKED");
  });

  it("ErrorEnvelope rejects an unknown code", () => {
    expect(() =>
      ErrorEnvelope.parse({ error: { code: "TOTALLY_MADE_UP", message: "x" } }),
    ).toThrow();
  });
});

describe("GhostWebEvidence / WebEvidence", () => {
  const okEvidence = {
    status: "ok" as const,
    sightings: [{ url: "https://boards.greenhouse.io/acme/jobs/1", source: "Greenhouse", postedDate: "2026-06-01" }],
    companySignals: ["careers page lists role"],
    summary: "Seen on Greenhouse, one posting in 90 days.",
    confidence: 0.8,
  };

  it("GhostWebEvidence parses a valid sighting list", () => {
    const { status: _status, ...bare } = okEvidence;
    expect(GhostWebEvidence.parse(bare)).toEqual(bare);
  });

  it("GhostWebEvidence rejects a non-URL sighting", () => {
    expect(() =>
      GhostWebEvidence.parse({
        sightings: [{ url: "not-a-url", source: "X" }],
        companySignals: [],
        summary: "x",
        confidence: 0.5,
      }),
    ).toThrow();
  });

  it("GhostWebEvidence rejects confidence out of [0,1]", () => {
    expect(() =>
      GhostWebEvidence.parse({ sightings: [], companySignals: [], summary: "x", confidence: 1.5 }),
    ).toThrow();
  });

  it("WebEvidence parses the ok variant", () => {
    const parsed = WebEvidence.parse(okEvidence);
    expect(parsed.status).toBe("ok");
  });

  it("WebEvidence parses the failed variant", () => {
    const parsed = WebEvidence.parse({ status: "failed", reason: "search provider timed out" });
    expect(parsed.status).toBe("failed");
  });

  it("WebEvidence rejects an unknown status", () => {
    expect(() => WebEvidence.parse({ status: "pending" })).toThrow();
  });

  it("Legitimacy.webEvidence is optional and accepts either variant", () => {
    const base = { tier: "verified" as const, tone: "verified" as const, summary: "x" };
    expect(Legitimacy.parse(base).webEvidence).toBeUndefined();
    expect(
      Legitimacy.parse({ ...base, webEvidence: { status: "failed", reason: "timeout" } }).webEvidence,
    ).toEqual({ status: "failed", reason: "timeout" });
  });
});

describe("UrlCheckRequest", () => {
  it("accepts a bare url", () => {
    expect(UrlCheckRequest.parse({ url: "https://example.com/jobs/1" })).toEqual({
      url: "https://example.com/jobs/1",
    });
  });

  it("accepts url + text", () => {
    const parsed = UrlCheckRequest.parse({ url: "https://example.com/jobs/1", text: "job description" });
    expect(parsed.text).toBe("job description");
  });

  it("rejects a non-URL url", () => {
    expect(() => UrlCheckRequest.parse({ url: "not-a-url" })).toThrow();
  });

  it("rejects an empty text", () => {
    expect(() => UrlCheckRequest.parse({ url: "https://example.com/jobs/1", text: "" })).toThrow();
  });
});

describe("UrlCheck", () => {
  const base = {
    id: "5c1f2b2e-5c1a-4b3e-9c9a-0f1a2b3c4d5e",
    url: "https://example.com/jobs/1",
    status: "queued" as const,
    stage: null,
    jobId: null,
    alreadyKnown: false,
    needsText: false,
    error: null,
    createdAt: "2026-07-12T00:00:00.000Z",
    finishedAt: null,
  };

  it("round-trips a full valid row", () => {
    expect(UrlCheck.parse(base)).toEqual(base);
  });

  it("needsText is required, not defaulted", () => {
    const { needsText: _needsText, ...withoutNeedsText } = base;
    expect(() => UrlCheck.parse(withoutNeedsText)).toThrow();
  });

  it("stage accepts any open string (fetching/searching/... not a closed enum)", () => {
    expect(UrlCheck.parse({ ...base, stage: "some-future-stage-name" }).stage).toBe(
      "some-future-stage-name",
    );
  });

  it("error uses ErrorCode and requires a message", () => {
    const parsed = UrlCheck.parse({
      ...base,
      status: "failed",
      needsText: true,
      error: { code: "FETCH_BLOCKED", message: "search tier found nothing" },
    });
    expect(parsed.error).toEqual({ code: "FETCH_BLOCKED", message: "search tier found nothing" });
  });

  it("rejects an error object with an unknown code", () => {
    expect(() =>
      UrlCheck.parse({ ...base, error: { code: "NOT_REAL", message: "x" } }),
    ).toThrow();
  });

  it("rejects a non-uuid id", () => {
    expect(() => UrlCheck.parse({ ...base, id: "not-a-uuid" })).toThrow();
  });
});

describe("ScheduleFlex / EmploymentPref", () => {
  it("ScheduleFlex accepts the three ordered levels and rejects others", () => {
    expect(ScheduleFlex.parse("base-hours")).toBe("base-hours");
    expect(ScheduleFlex.parse("flex-evenings")).toBe("flex-evenings");
    expect(ScheduleFlex.parse("any-hours")).toBe("any-hours");
    expect(() => ScheduleFlex.parse("evenings")).toThrow();
  });
  it("EmploymentPref accepts any|employee|local-entity", () => {
    expect(EmploymentPref.parse("employee")).toBe("employee");
    expect(() => EmploymentPref.parse("eor")).toThrow();
  });
  it("Profile requires the two new dials (fail loud, no default)", () => {
    expect(() =>
      Profile.parse({ baseCountry: "MY", relocation: "stay", updatedAt: "2026-07-14T00:00:00.000Z" }),
    ).toThrow();
    const p = Profile.parse({
      baseCountry: "MY", relocation: "stay",
      scheduleFlex: "any-hours", employmentPref: "any",
      displayLocation: null, targetRole: null,
      salaryMin: null, salaryMax: null, salaryCurrency: null, salaryCadence: null,
      attrProvenance: {},
      updatedAt: "2026-07-14T00:00:00.000Z",
    });
    expect(p.scheduleFlex).toBe("any-hours");
  });
});

it("ErrorCode includes the auth codes", () => {
  expect(ErrorCode.options).toContain("UNAUTHORIZED");
  expect(ErrorCode.options).toContain("FORBIDDEN");
});

it("AuthUser never carries a password hash", () => {
  const parsed = AuthUser.parse({ id: "u1", email: "a@b.co", role: "user", passwordHash: "leak" });
  expect(parsed).not.toHaveProperty("passwordHash"); // strip via .parse
});

describe("AdminPoolStats", () => {
  const valid = {
    totals: { live: 100, delisted: 5, newLast24h: 3, sourcesEnabled: 8, sourcesTotal: 10, tagCoveragePct: 0.4 },
    functionMix: [{ bucket: "engineering", count: 40, share: 40, source: "keyword" as const }],
    tzBands: [{ band: "americas" as const, count: 60, share: 60 }],
    freshness: [{ bucket: "24h" as const, count: 3 }],
    concentration: { topCompanies: [{ company: "Acme", count: 10 }], top10Count: 10, restCount: 90 },
  };

  it("parses a well-formed snapshot", () => {
    expect(AdminPoolStats.parse(valid)).toEqual(valid);
  });

  it("throws when totals is missing (fail loud, no fallback defaults)", () => {
    const { totals, ...withoutTotals } = valid;
    expect(() => AdminPoolStats.parse(withoutTotals)).toThrow();
  });

  it("rejects an unknown tzBands.band value", () => {
    expect(() => AdminPoolStats.parse({ ...valid, tzBands: [{ band: "mars", count: 1, share: 1 }] })).toThrow();
  });

  it("rejects an unknown functionMix.source value", () => {
    expect(() =>
      AdminPoolStats.parse({ ...valid, functionMix: [{ bucket: "engineering", count: 1, share: 1, source: "llm" }] }),
    ).toThrow();
  });

  it("rejects a negative concentration.restCount", () => {
    expect(() =>
      AdminPoolStats.parse({ ...valid, concentration: { ...valid.concentration, restCount: -1 } }),
    ).toThrow();
  });
});

it("RegisterRequest enforces a minimum password length", () => {
  expect(RegisterRequest.safeParse({ email: "a@b.co", password: "short" }).success).toBe(false);
});
