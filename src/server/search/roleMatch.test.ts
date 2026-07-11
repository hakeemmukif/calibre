import { describe, expect, it } from "vitest";
import { deriveRoleTargets, roleFuzzyMatch, roleTokens } from "./roleMatch";

function target(titles: string[], keywords: string[] = []) {
  return { titles, keywords, persona: "remote" as const };
}

function posting(title: string) {
  return {
    sourceId: "greenhouse",
    url: "https://example.com/job",
    title,
    company: "Acme",
  };
}

describe("roleFuzzyMatch", () => {
  it("matches reposted same-role titles with 2+ shared tokens incl. one non-baseline, Jaccard >= 0.6", () => {
    expect(roleFuzzyMatch(target(["Senior Data Engineer"]), posting("Data Engineer"))).toBe(true);
  });

  it("does not match when overlap is only baseline vocabulary (software/engineer)", () => {
    expect(roleFuzzyMatch(target(["Software Engineer"]), posting("Full Stack Software Engineer"))).toBe(false);
  });

  it("does not match sibling roles with < 2 shared tokens", () => {
    expect(roleFuzzyMatch(target(["Backend Engineer"]), posting("Frontend Designer"))).toBe(false);
  });

  it("does not match when Jaccard overlap falls below 0.6 despite 2+ shared tokens incl. a non-baseline one", () => {
    // shared: {data, engineer} (data discriminating) but the posting's token
    // set is much larger → Jaccard well under 0.6.
    expect(
      roleFuzzyMatch(
        target(["Data Engineer"]),
        posting("Data Engineer, Kubernetes Platform Infrastructure Reliability And Observability Systems"),
      ),
    ).toBe(false);
  });

  it("keywords widen the target token pool (skills contribute discriminating tokens)", () => {
    expect(roleFuzzyMatch(target(["Engineer"], ["Kubernetes"]), posting("Kubernetes Engineer"))).toBe(true);
  });

  it("returns false when either side tokenizes to nothing", () => {
    expect(roleFuzzyMatch(target([""]), posting("Backend Engineer"))).toBe(false);
    expect(roleFuzzyMatch(target(["Backend Engineer"]), posting(""))).toBe(false);
  });

  // RED against the pre-fix all-pooled implementation: pooling all 4 titles'
  // + all 15 keywords' tokens into one ~19-token set makes the Jaccard
  // denominator huge for every posting (overlap 2 / union ~19 ≈ 0.1), so a
  // "Data Engineer" posting — a near-exact match of one of the résumé's own
  // titles — was rejected. GREEN after the pairwise fix: matched per-title
  // against "Senior Data Engineer" (title tokens {data, engineer} vs posting
  // tokens {data, engineer} → Jaccard 1.0), independent of the other titles/
  // keywords in the pool.
  it("realistic multi-role, multi-skill résumé matches a relevant posting and rejects an unrelated one", () => {
    const realisticTarget = target(
      ["Senior Data Engineer", "Backend Engineer", "Data Platform Engineer", "Analytics Engineer"],
      [
        "Python", "SQL", "Kubernetes", "Docker", "AWS", "Airflow", "Spark", "Kafka",
        "Terraform", "dbt", "Snowflake", "Postgres", "Redis", "GraphQL", "TypeScript",
      ],
    );

    expect(roleFuzzyMatch(realisticTarget, posting("Data Engineer"))).toBe(true);
    expect(roleFuzzyMatch(realisticTarget, posting("Product Marketing Manager"))).toBe(false);
  });
});

describe("roleTokens", () => {
  it("drops stopwords and short generic words, keeps short specialty acronyms", () => {
    expect(roleTokens("Senior Remote QA Engineer")).toEqual(["qa", "engineer"]);
  });
});

describe("deriveRoleTargets", () => {
  it("derives titles from experience + headline, keywords from skills", () => {
    const resume = {
      structured: {
        name: "Jane Doe",
        contact: [{ label: "email", value: "jane@example.com" }],
        summary: "Backend engineer.",
        experience: [
          { company: "Acme", title: "Senior Backend Engineer", dates: "2022–Present", bullets: [] },
          { company: "Old Co", title: "Backend Engineer", dates: "2018–2022", bullets: [] },
        ],
        education: [],
        skills: [
          { label: "Languages", items: ["TypeScript", "Go"] },
          { label: "Infra", items: ["Kubernetes"] },
        ],
        extras: [],
      },
    };

    const [target] = deriveRoleTargets(resume, "remote");
    expect(target.persona).toBe("remote");
    expect(target.titles).toEqual(["Senior Backend Engineer", "Backend Engineer"]);
    expect(target.keywords).toEqual(["TypeScript", "Go", "Kubernetes"]);
  });

  it("falls back to a contact headline line over experience[0].title when present", () => {
    const resume = {
      structured: {
        name: "Jane Doe",
        contact: [{ label: "headline", value: "Staff Platform Engineer" }],
        summary: "s",
        experience: [{ company: "Acme", title: "Senior Backend Engineer", dates: "2022–Present", bullets: [] }],
        education: [],
        skills: [],
        extras: [],
      },
    };

    const [target] = deriveRoleTargets(resume, "local");
    expect(target.titles).toEqual(["Senior Backend Engineer", "Staff Platform Engineer"]);
  });
});
