import { describe, expect, it } from "vitest";
import type { LegitimacyTier, WebEvidence } from "@/types";
import { ATS_SIGHTING_HOSTS, deriveRepostStats, legitimacyTone, resolveLegitimacyTier } from "./legitimacy";

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

describe("legitimacyTone", () => {
  const table: [LegitimacyTier, string][] = [
    ["verified", "verified"],
    ["clear", "good"],
    ["suspicious", "warn"],
    ["ghost", "ghost"],
    ["scam", "danger"],
  ];

  it.each(table)("%s -> %s", (tier, tone) => {
    expect(legitimacyTone(tier)).toBe(tone);
  });
});

describe("resolveLegitimacyTier", () => {
  it("clear + active liveness -> clear", () => {
    expect(resolveLegitimacyTier({ tier: "clear", liveness: "active" })).toBe("clear");
  });

  it("verified + corroborated -> verified", () => {
    expect(resolveLegitimacyTier({ tier: "verified", liveness: "active", corroborated: true })).toBe("verified");
  });

  it("verified without corroboration is downgraded to clear", () => {
    expect(resolveLegitimacyTier({ tier: "verified", liveness: "active", corroborated: false })).toBe("clear");
    expect(resolveLegitimacyTier({ tier: "verified", liveness: "active" })).toBe("clear");
  });

  it("suspicious passes through unchanged", () => {
    expect(resolveLegitimacyTier({ tier: "suspicious", liveness: "active" })).toBe("suspicious");
  });

  it("expired liveness overrides a good model tier -> ghost", () => {
    expect(resolveLegitimacyTier({ tier: "clear", liveness: "expired" })).toBe("ghost");
  });

  it("model scam tier -> scam even when liveness is active", () => {
    expect(resolveLegitimacyTier({ tier: "scam", liveness: "active" })).toBe("scam");
  });

  it("scam wins over expired liveness too", () => {
    expect(resolveLegitimacyTier({ tier: "scam", liveness: "expired" })).toBe("scam");
  });

  it("uncertain liveness does not itself force ghost", () => {
    expect(resolveLegitimacyTier({ tier: "clear", liveness: "uncertain" })).toBe("clear");
  });

  // spec 2026-07-12-pasted-job-ingestion-design.md §9 — webEvidence permutations.
  // Scanned jobs never pass webEvidence, so every test above (unmodified) is
  // the "no-webEvidence behaviour byte-identical to today" regression check.

  it("repost count90d>=3 with oldestDays>=60 forces ghost", () => {
    const webEvidence: WebEvidence = {
      status: "ok",
      sightings: [
        { url: "https://a.example.com/1", source: "A", postedDate: daysAgo(10) },
        { url: "https://a.example.com/2", source: "B", postedDate: daysAgo(30) },
        { url: "https://a.example.com/3", source: "C", postedDate: daysAgo(65) },
      ],
      companySignals: [],
      summary: "Reposted repeatedly over months.",
      confidence: 0.8,
    };
    expect(resolveLegitimacyTier({ tier: "clear", liveness: "active", webEvidence })).toBe("ghost");
  });

  it("repost count90d>=3 with oldestDays<60 raises the tier to at least suspicious", () => {
    const webEvidence: WebEvidence = {
      status: "ok",
      sightings: [
        { url: "https://a.example.com/1", source: "A", postedDate: daysAgo(5) },
        { url: "https://a.example.com/2", source: "B", postedDate: daysAgo(20) },
        { url: "https://a.example.com/3", source: "C", postedDate: daysAgo(45) },
      ],
      companySignals: [],
      summary: "Reposted a few times recently.",
      confidence: 0.8,
    };
    expect(resolveLegitimacyTier({ tier: "clear", liveness: "active", webEvidence })).toBe("suspicious");
  });

  it("a corroborated-verified pasted job with an ATS-allowlisted sighting is never demoted by the repost rule", () => {
    const webEvidence: WebEvidence = {
      status: "ok",
      sightings: [
        { url: "https://boards.greenhouse.io/acme/jobs/1", source: "Greenhouse", postedDate: daysAgo(10) },
        { url: "https://www.linkedin.com/jobs/view/1", source: "LinkedIn", postedDate: daysAgo(20) },
        { url: "https://www.indeed.com/viewjob?jk=1", source: "Indeed", postedDate: daysAgo(30) },
      ],
      companySignals: [],
      summary: "Actively listed on the company's own ATS.",
      confidence: 0.9,
    };
    expect(resolveLegitimacyTier({ tier: "verified", liveness: "active", corroborated: true, webEvidence })).toBe(
      "verified",
    );
  });

  it("pasted verified without an ATS-allowlisted sighting downgrades to clear", () => {
    const webEvidence: WebEvidence = {
      status: "ok",
      sightings: [{ url: "https://www.linkedin.com/jobs/view/1", source: "LinkedIn", postedDate: daysAgo(10) }],
      companySignals: [],
      summary: "Seen on LinkedIn only.",
      confidence: 0.7,
    };
    expect(resolveLegitimacyTier({ tier: "verified", liveness: "active", corroborated: true, webEvidence })).toBe(
      "clear",
    );
  });

  it("webEvidence status 'failed' leaves a non-verified model tier untouched (repost rule skipped)", () => {
    const webEvidence: WebEvidence = { status: "failed", reason: "sonar timeout" };
    expect(resolveLegitimacyTier({ tier: "suspicious", liveness: "active", webEvidence })).toBe("suspicious");
  });

  it("webEvidence status 'failed' cannot corroborate a verified tier -> clear", () => {
    const webEvidence: WebEvidence = { status: "failed", reason: "sonar timeout" };
    expect(resolveLegitimacyTier({ tier: "verified", liveness: "active", corroborated: true, webEvidence })).toBe(
      "clear",
    );
  });

  it("undated sightings never trigger the repost rule, however many there are", () => {
    const webEvidence: WebEvidence = {
      status: "ok",
      sightings: [
        { url: "https://a.example.com/1", source: "A" },
        { url: "https://a.example.com/2", source: "B" },
        { url: "https://a.example.com/3", source: "C" },
      ],
      companySignals: [],
      summary: "Seen on multiple boards, no dates given.",
      confidence: 0.6,
    };
    expect(resolveLegitimacyTier({ tier: "clear", liveness: "active", webEvidence })).toBe("clear");
  });
});

describe("ATS_SIGHTING_HOSTS", () => {
  it("matches the spec allowlist (§9)", () => {
    expect(ATS_SIGHTING_HOSTS).toEqual(["greenhouse.io", "lever.co", "ashbyhq.com", "workable.com", "smartrecruiters.com"]);
  });
});

describe("deriveRepostStats", () => {
  it("dedupes sightings by (source, postedDate)", () => {
    const dated = daysAgo(10);
    const stats = deriveRepostStats([
      { url: "https://a.example.com/1", source: "LinkedIn", postedDate: dated },
      { url: "https://a.example.com/2", source: "LinkedIn", postedDate: dated },
    ]);
    expect(stats.count90d).toBe(1);
  });

  it("excludes undated sightings from churn", () => {
    const stats = deriveRepostStats([
      { url: "https://a.example.com/1", source: "LinkedIn" },
      { url: "https://a.example.com/2", source: "Indeed" },
    ]);
    expect(stats.count90d).toBe(0);
    expect(stats.oldestDays).toBeNull();
  });

  it("count90d counts only dated sightings within 90 days; oldestDays is the max age across all dated sightings", () => {
    const stats = deriveRepostStats([
      { url: "https://a.example.com/1", source: "LinkedIn", postedDate: daysAgo(10) },
      { url: "https://a.example.com/2", source: "Indeed", postedDate: daysAgo(45) },
      { url: "https://a.example.com/3", source: "Glassdoor", postedDate: daysAgo(91) },
    ]);
    expect(stats.count90d).toBe(2);
    expect(stats.oldestDays).toBe(91);
  });
});
