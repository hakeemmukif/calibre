import { describe, expect, it } from "vitest";
import type { ResumeStore } from "./resume-store";
import { computeQuantifiedBulletRatio, computeResumeMetrics } from "./resume-metrics";

type ExperienceEntry = ResumeStore["experience"][number];

function experience(over: Partial<ExperienceEntry> = {}): ExperienceEntry {
  return {
    company: "Co",
    title: "Engineer",
    dates: "",
    isCurrent: false,
    bullets: [],
    ...over,
  };
}

function baseStore(over: Partial<ResumeStore> = {}): ResumeStore {
  return {
    storeVersion: 2,
    extractionPath: "text",
    name: "Jane Doe",
    contact: [],
    summary: "",
    experience: [],
    education: [],
    skills: [],
    projects: [],
    certifications: [],
    languages: [],
    sections: [],
    ...over,
  };
}

describe("computeResumeMetrics", () => {
  it("returns all-zero metrics for a fully empty résumé", () => {
    const metrics = computeResumeMetrics(baseStore());
    expect(metrics).toEqual({
      totalYearsExperience: 0,
      currentTenureMonths: 0,
      roleCount: 0,
      durationDerivedRoleCount: 0,
      avgTenureMonths: 0,
      distinctSkillCount: 0,
      certificationCount: 0,
      languageCount: 0,
      quantifiedBulletRatio: 0,
    });
  });

  it("merges overlapping role intervals instead of double-counting years", () => {
    const store = baseStore({
      experience: [
        experience({ company: "Acme", dates: "2020–2022", start: "2020-01", end: "2022-01" }),
        experience({ company: "Beta", dates: "2021–2023", start: "2021-01", end: "2023-01" }),
      ],
    });
    // Jan2020–Jan2022 union Jan2021–Jan2023 = Jan2020–Jan2023 = 3 years, not 4.
    expect(computeResumeMetrics(store).totalYearsExperience).toBe(3);
  });

  it("sums non-overlapping role intervals", () => {
    const store = baseStore({
      experience: [
        experience({ company: "Acme", dates: "2018–2019", start: "2018-01", end: "2019-01" }),
        experience({ company: "Beta", dates: "2020–2021", start: "2020-01", end: "2021-01" }),
      ],
    });
    expect(computeResumeMetrics(store).totalYearsExperience).toBe(2);
  });

  it("computes currentTenureMonths from the current role's start atom to `now`", () => {
    const store = baseStore({
      experience: [experience({ company: "Acme", dates: "2024-01–Present", start: "2024-01", isCurrent: true })],
    });
    const now = new Date(2024, 6, 1); // July 2024 (month index 6, 0-based)
    expect(computeResumeMetrics(store, now).currentTenureMonths).toBe(6);
  });

  it("returns 0 currentTenureMonths when no role isCurrent", () => {
    const store = baseStore({
      experience: [experience({ company: "Acme", dates: "2020–2022", start: "2020-01", end: "2022-01" })],
    });
    expect(computeResumeMetrics(store, new Date(2024, 0, 1)).currentTenureMonths).toBe(0);
  });

  it("picks the longest-running entry when several roles are isCurrent", () => {
    const store = baseStore({
      experience: [
        experience({ company: "Short", dates: "2024-01–Present", start: "2024-01", isCurrent: true }),
        experience({ company: "Long", dates: "2022-01–Present", start: "2022-01", isCurrent: true }),
      ],
    });
    const now = new Date(2024, 6, 1); // July 2024
    // Long started Jan 2022 -> 30 months by July 2024; Short only 6 months.
    expect(computeResumeMetrics(store, now).currentTenureMonths).toBe(30);
  });

  it("counts roleCount as experience.length even when a role's duration is undrivable", () => {
    const store = baseStore({
      experience: [
        experience({ company: "Acme", dates: "2020–2022", start: "2020-01", end: "2022-01" }),
        experience({ company: "Freelance", dates: "assorted gigs" }),
      ],
    });
    expect(computeResumeMetrics(store).roleCount).toBe(2);
  });

  it("excludes an undrivable-duration role from avgTenureMonths instead of counting it as 0", () => {
    const store = baseStore({
      experience: [
        experience({ company: "Acme", dates: "2020–2021", start: "2020-01", end: "2021-01" }), // 12 months
        experience({ company: "Freelance", dates: "assorted gigs" }), // undrivable
      ],
    });
    expect(computeResumeMetrics(store).avgTenureMonths).toBe(12);
  });

  it("averages avgTenureMonths across all derivable roles", () => {
    const store = baseStore({
      experience: [
        experience({ company: "Acme", dates: "2020–2021", start: "2020-01", end: "2021-01" }), // 12 months
        experience({ company: "Beta", dates: "2021–2022", start: "2021-01", end: "2022-06" }), // 17 months
      ],
    });
    expect(computeResumeMetrics(store).avgTenureMonths).toBe(14.5);
  });

  it("dedupes distinctSkillCount across skill groups", () => {
    const store = baseStore({
      skills: [
        { label: "Languages", items: ["TypeScript", "Go"] },
        { label: "Backend", items: ["Go", "Postgres"] },
      ],
    });
    expect(computeResumeMetrics(store).distinctSkillCount).toBe(3);
  });

  it("counts certifications and languages directly", () => {
    const store = baseStore({
      certifications: [{ name: "PMP" }, { name: "Scrum Master" }],
      languages: [{ language: "English" }, { language: "Malay" }, { language: "Mandarin" }],
    });
    const metrics = computeResumeMetrics(store);
    expect(metrics.certificationCount).toBe(2);
    expect(metrics.languageCount).toBe(3);
  });

  it("computes quantifiedBulletRatio across experience + project bullets", () => {
    const store = baseStore({
      experience: [
        experience({ bullets: ["Grew revenue 40%", "Led the team", "Saved $2M in costs"] }),
      ],
      projects: [{ name: "Side project", bullets: ["Shipped to 10k users", "Wrote documentation"] }],
    });
    // 5 bullets total, 3 quantified (40%, $2M, 10k) -> 0.6
    expect(computeResumeMetrics(store).quantifiedBulletRatio).toBe(0.6);
  });

  it("returns 0 quantifiedBulletRatio when there are no bullets", () => {
    const store = baseStore({ experience: [experience({ bullets: [] })] });
    expect(computeResumeMetrics(store).quantifiedBulletRatio).toBe(0);
  });

  it("parses a year-only dates string when start/end atoms are absent (year-only fixture)", () => {
    const store = baseStore({
      experience: [experience({ company: "Meridian Co", dates: "2021 - 2024" })],
    });
    // Year-only range parsed at Jan-granularity: 2021-01 to 2024-01 = 3 years.
    expect(computeResumeMetrics(store).totalYearsExperience).toBe(3);
    expect(computeResumeMetrics(store).avgTenureMonths).toBe(36);
  });

  it("parses an ongoing year-only dates string ('YYYY – Present') to `now` when atoms are absent", () => {
    const store = baseStore({
      experience: [experience({ company: "Meridian Co", dates: "2022 – Present", isCurrent: true })],
    });
    const now = new Date(2024, 0, 1); // Jan 2024
    expect(computeResumeMetrics(store, now).currentTenureMonths).toBe(24);
  });

  it("does not treat 'unknown' as an ongoing year-range (word-boundary parity with CURRENT_RE)", () => {
    const store = baseStore({
      experience: [experience({ company: "X", dates: "2019 – unknown" })],
    });
    // Not current, no parseable end -> undrivable -> excluded, not counted as 0.
    const metrics = computeResumeMetrics(store);
    expect(metrics.totalYearsExperience).toBe(0);
    expect(metrics.avgTenureMonths).toBe(0);
  });

  it("parses a 'YYYY to YYYY' dates string (no dash) when atoms are absent", () => {
    const store = baseStore({
      experience: [experience({ company: "NoDash Co", dates: "2018 to 2022" })],
    });
    expect(computeResumeMetrics(store).totalYearsExperience).toBe(4);
  });

  it("parses a month-name dates string ('Jun 2020 – Aug 2022') when atoms are absent", () => {
    const store = baseStore({
      experience: [experience({ company: "Months Co", dates: "Jun 2020 – Aug 2022" })],
    });
    expect(computeResumeMetrics(store).totalYearsExperience).toBe(2);
  });

  it("parses a dash-less ongoing dates string ('Since 2019') to `now` when atoms are absent", () => {
    const store = baseStore({
      experience: [experience({ company: "Since Co", dates: "Since 2019", isCurrent: true })],
    });
    const now = new Date(2024, 0, 1); // Jan 2024
    expect(computeResumeMetrics(store, now).currentTenureMonths).toBe(60);
  });

  it("reports durationDerivedRoleCount as a partial coverage signal when only some roles resolve", () => {
    const store = baseStore({
      experience: [
        experience({ company: "Acme", dates: "2020–2022", start: "2020-01", end: "2022-01" }),
        experience({ company: "NoDash Co", dates: "2018 to 2022" }),
        experience({ company: "Freelance", dates: "assorted gigs" }),
      ],
    });
    const metrics = computeResumeMetrics(store);
    expect(metrics.roleCount).toBe(3);
    expect(metrics.durationDerivedRoleCount).toBe(2);
  });

  it("distinguishes an all-underivable résumé (0 years) from a genuine zero-experience one via durationDerivedRoleCount", () => {
    const store = baseStore({
      experience: [
        experience({ company: "Freelance", dates: "assorted gigs" }),
        experience({ company: "Consulting", dates: "various" }),
      ],
    });
    const metrics = computeResumeMetrics(store);
    expect(metrics.totalYearsExperience).toBe(0);
    expect(metrics.roleCount).toBe(2);
    expect(metrics.durationDerivedRoleCount).toBe(0);
  });

  it("is deterministic for the same input and `now`", () => {
    const store = baseStore({
      experience: [experience({ dates: "2020–2022", start: "2020-01", end: "2022-01" })],
    });
    const now = new Date(2024, 0, 1);
    expect(computeResumeMetrics(store, now)).toEqual(computeResumeMetrics(store, now));
  });
});

describe("computeQuantifiedBulletRatio", () => {
  it("counts a digit, %, or $ as quantified but not a plain bullet (standalone export atsScore.ts folds in)", () => {
    const store = baseStore({
      experience: [experience({ bullets: ["Grew revenue 40%", "Led the team", "Saved $2M in costs"] })],
      projects: [{ name: "Side project", bullets: ["Shipped to 10k users", "Wrote documentation"] }],
    });
    expect(computeQuantifiedBulletRatio(store)).toBe(0.6);
  });

  it("returns 0 when there are no bullets", () => {
    expect(computeQuantifiedBulletRatio(baseStore())).toBe(0);
  });
});
