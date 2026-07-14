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

  // Flipped by task-7b's all-baseline containment exception (deliberate
  // deviation from the donor rule): "Software Engineer" tokenizes entirely to
  // BASELINE_TOKENS, so under the donor's rule it could NEVER match anything
  // — including a posting fully containing it. That is exactly the hole
  // observed live; containment of an all-baseline title now matches. Baseline
  // overlap WITHOUT full containment still never matches (see the
  // "Backend Engineer, Payments Infrastructure" case below).
  it("matches when an all-baseline title is fully contained in the posting (was a donor-rule dead end)", () => {
    expect(roleFuzzyMatch(target(["Software Engineer"]), posting("Full Stack Software Engineer"))).toBe(true);
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

describe("roleFuzzyMatch — all-baseline full-title-containment exception", () => {
  // Live evidence (task-7b): the résumé title "Full-Stack Engineer" tokenizes
  // entirely to BASELINE_TOKENS (full/stack/engineer), so the discriminating-
  // token rule can never fire from its own words and even Stripe's literal
  // "Full Stack Engineer" posting was rejected. For ALL-BASELINE titles only,
  // full containment of the (>=2-token) title in the posting is accepted;
  // domain-flavored titles keep the donor's strict path.
  it("matches an exact-title posting even though every token is baseline vocabulary", () => {
    expect(roleFuzzyMatch(target(["Full-Stack Engineer"]), posting("Full Stack Engineer"))).toBe(true);
  });

  it("matches when the posting adds seniority/domain tokens around the contained title", () => {
    expect(
      roleFuzzyMatch(target(["Full-Stack Engineer"]), posting("Senior Full Stack Engineer (Remote) - Payments")),
    ).toBe(true);
  });

  it("does not match when the posting title does not contain every résumé title token", () => {
    expect(
      roleFuzzyMatch(target(["Full-Stack Engineer"]), posting("Backend Engineer, Payments Infrastructure")),
    ).toBe(false);
  });

  // Pins the regression the first (unscoped) containment attempt introduced:
  // a NON-baseline title ("data" is discriminating) fully contained in a long
  // unrelated posting must NOT match via containment — the all-baseline gate
  // excludes it, leaving the donor's Jaccard guard to reject it.
  it("does not extend containment to domain-flavored titles contained in long unrelated postings", () => {
    expect(
      roleFuzzyMatch(
        target(["Data Engineer"]),
        posting("Data Engineer, Kubernetes Platform Infrastructure Reliability And Observability Systems"),
      ),
    ).toBe(false);
  });

  it("does not match via containment for a single-token résumé title (>=2 guard)", () => {
    expect(roleFuzzyMatch(target(["Engineer"]), posting("Engineer"))).toBe(false);
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
        storeVersion: 2 as const,
        extractionPath: "text" as const,
        name: "Jane Doe",
        contact: [{ label: "email", value: "jane@example.com" }],
        summary: "Backend engineer.",
        experience: [
          { company: "Acme", title: "Senior Backend Engineer", dates: "2022–Present", isCurrent: true, bullets: [] },
          { company: "Old Co", title: "Backend Engineer", dates: "2018–2022", isCurrent: false, bullets: [] },
        ],
        education: [],
        skills: [
          { label: "Languages", items: ["TypeScript", "Go"] },
          { label: "Infra", items: ["Kubernetes"] },
        ],
        projects: [],
        certifications: [],
        languages: [],
        sections: [],
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
        storeVersion: 2 as const,
        extractionPath: "text" as const,
        name: "Jane Doe",
        contact: [{ label: "headline", value: "Staff Platform Engineer" }],
        summary: "s",
        experience: [{ company: "Acme", title: "Senior Backend Engineer", dates: "2022–Present", isCurrent: true, bullets: [] }],
        education: [],
        skills: [],
        projects: [],
        certifications: [],
        languages: [],
        sections: [],
      },
    };

    const [target] = deriveRoleTargets(resume, "local");
    expect(target.titles).toEqual(["Senior Backend Engineer", "Staff Platform Engineer"]);
  });
});
