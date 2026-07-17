import { describe, expect, it } from "vitest";
import { deriveRoleTargets, roleFuzzyMatch, roleTokens } from "./roleMatch";
import { expandRoleTitles } from "./roleSynonyms";

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

  // DELIBERATELY RE-PINNED false → true (2026-07-17). This was a donor-derived
  // negative: it pinned the donor's Jaccard-only rule, where {data, engineer}
  // against a much larger posting token set lands well under 0.6 and rejects.
  // The stress test over 2,906 live ATS postings
  // (docs/superpowers/reports/2026-07-17-matching-stress-test.md §3.1) shows the
  // pin encodes the under-matching bug itself rather than a real negative: the
  // "<Role>, <Department>" shape it is written in is the single largest
  // false-negative family on real boards — the same shape as "Product Manager,
  // Cash Platform" (Stripe) and "Engineering Manager, Data Foundations"
  // (GitLab), which cost 500+ real matches and drove product recall to 0.14.
  // The résumé title is FULLY contained and in order; an appended department
  // qualifier is not evidence of a different role. Overriding the donor here is
  // what takes overall recall 0.425 → 0.722 at FP 190 → 141. The Jaccard floor
  // itself is UNCHANGED and still guards the token path (see the negative pins
  // below); this pair now matches via the phrase path.
  it("matches a fully-contained title under an appended department qualifier (was a donor Jaccard rejection)", () => {
    expect(
      roleFuzzyMatch(
        target(["Data Engineer"]),
        posting("Data Engineer, Kubernetes Platform Infrastructure Reliability And Observability Systems"),
      ),
    ).toBe(true);
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

  // Same assertion as the re-pinned fixture in the first describe block (this
  // file pinned the pair twice); see that comment for why the donor negative is
  // deliberately overridden by the real-data evidence. Kept here because this
  // block owns the containment rule: containment is no longer scoped to
  // all-baseline titles — it is now ORDERED (phrase) containment for every
  // title, which is what makes admitting a domain-flavored title safe.
  it("extends phrase containment to domain-flavored titles (no longer scoped to all-baseline)", () => {
    expect(
      roleFuzzyMatch(
        target(["Data Engineer"]),
        posting("Data Engineer, Kubernetes Platform Infrastructure Reliability And Observability Systems"),
      ),
    ).toBe(true);
  });

  it("does not match via containment for a single-token résumé title (>=2 guard)", () => {
    expect(roleFuzzyMatch(target(["Engineer"]), posting("Engineer"))).toBe(false);
  });
});

// Spec 2026-07-16 §3 verified the donor-inherited matcher rejects every
// non-engineering title — even against a LITERALLY IDENTICAL posting title —
// because (1) roleTokens dropped all words ≤3 chars unless in a tech-only
// acronym list (CEO/CTO/CFO/COO/VP → []), and (2) the overlap ≥2 floor killed
// single-token roles (Head of Finance → ["finance"]). §4.1/§5 mandate these
// fixtures: each title must match its identical posting AND a plausible
// variant, without the matcher becoming match-everything.
describe("roleFuzzyMatch — de-biased across job functions (spec §4.1/§5)", () => {
  const identicalAndVariant: Array<[resumeTitle: string, variantPosting: string]> = [
    ["CEO", "CEO (Remote)"],
    ["CFO", "CFO - Remote"],
    ["CTO", "CTO (Remote)"],
    ["COO", "COO (Remote, APAC)"],
    ["VP of Marketing", "VP, Marketing"],
    ["Head of Finance", "Finance Lead"],
    ["Head of Operations", "Operations Lead"],
    ["Chief of Staff", "Chief of Staff (Remote)"],
    ["Recruiter", "Senior Recruiter"],
  ];

  for (const [resumeTitle, variantPosting] of identicalAndVariant) {
    it(`"${resumeTitle}" matches its identical posting title`, () => {
      expect(roleFuzzyMatch(target([resumeTitle]), posting(resumeTitle))).toBe(true);
    });

    it(`"${resumeTitle}" matches the plausible variant "${variantPosting}"`, () => {
      expect(roleFuzzyMatch(target([resumeTitle]), posting(variantPosting))).toBe(true);
    });
  }

  // De-biasing must not become match-everything: baseline-only collisions and
  // cross-function pairs still reject. ("Backend Engineer" vs "Frontend
  // Designer" and the Jaccard-fail donor rejections stay pinned in the first
  // describe block above.)
  it("still rejects a bare baseline-token collision (Manager vs Manager)", () => {
    expect(roleFuzzyMatch(target(["Manager"]), posting("Manager"))).toBe(false);
  });

  it("still rejects a bare baseline title against a broader posting (Engineer vs Software Engineer)", () => {
    expect(roleFuzzyMatch(target(["Engineer"]), posting("Software Engineer"))).toBe(false);
  });

  it("does not match across C-suite functions (CEO vs CTO)", () => {
    expect(roleFuzzyMatch(target(["CEO"]), posting("CTO"))).toBe(false);
  });

  it("a shared seniority acronym alone is not a match (VP of Marketing vs VP of Engineering)", () => {
    expect(roleFuzzyMatch(target(["VP of Marketing"]), posting("VP of Engineering"))).toBe(false);
  });

  it("does not match across Head-of functions (Head of Finance vs Head of Engineering)", () => {
    expect(roleFuzzyMatch(target(["Head of Finance"]), posting("Head of Engineering"))).toBe(false);
  });

  it("Chief of Staff does not bleed into Staff Engineer", () => {
    expect(roleFuzzyMatch(target(["Chief of Staff"]), posting("Staff Engineer"))).toBe(false);
  });
});

// The task-1.1 de-bias replaced the donor's >3-char token floor with >=2,
// which started admitting abbreviated seniority ("sr"/"jr") and roman-numeral
// levels ("ii"/"iii"/"iv") as if they were discriminating words. Every §3
// fixture spells out "Senior", so the hole went unseen: for titles whose
// surviving overlap is ALL-BASELINE, the stray glue token makes the title no
// longer all-baseline, skipping the containment shortcut, and can never
// contribute overlap against a posting that lacks it. These are among the most
// common résumé spellings in the shipped engineering niche.
describe("roleFuzzyMatch — abbreviated seniority and roman-numeral levels are glue", () => {
  const seniorityGlue: Array<[resumeTitle: string, postingTitle: string]> = [
    ["Sr. Software Engineer", "Software Engineer"],
    ["Jr. Software Engineer", "Software Engineer"],
    ["Software Engineer II", "Software Engineer"],
    ["Software Engineer III", "Software Engineer"],
    ["Software Engineer IV", "Software Engineer"],
    ["Software Engineer II", "Software Engineer III"],
    ["Sr Software Engineer", "Software Engineer II"],
  ];

  for (const [resumeTitle, postingTitle] of seniorityGlue) {
    it(`"${resumeTitle}" matches "${postingTitle}"`, () => {
      expect(roleFuzzyMatch(target([resumeTitle]), posting(postingTitle))).toBe(true);
    });
  }

  // Never regressed (the "data" token carries it) — pinned so the stopword
  // additions can't be blamed for a future break here.
  it("keeps matching when the surviving overlap is discriminating (Sr. Data Engineer)", () => {
    expect(roleFuzzyMatch(target(["Sr. Data Engineer"]), posting("Data Engineer"))).toBe(true);
  });

  // Dropping the level glue must not manufacture a match: "Engineer II" and
  // "Engineer" both reduce to the single baseline token ["engineer"], which the
  // bare-baseline guard already rejects.
  it("does not turn a bare baseline title into a match once the level token is dropped", () => {
    expect(roleFuzzyMatch(target(["Engineer II"]), posting("Engineer"))).toBe(false);
  });
});

// Every title below is quoted VERBATIM from
// src/server/search/__fixtures__/live-titles.json — 2,906 postings harvested
// live from the 15 seeded ATS boards on 2026-07-17. The synthetic fixtures above
// passed while the SHIPPED matcher scored 0.425 recall on this real inventory
// (product 0.14, exec 0.11, people 0.06, recruiter 0.00) — invented titles do
// not carry the forms real boards write, so these pin the measured causes
// directly. Analysis + per-function numbers:
// docs/superpowers/reports/2026-07-17-matching-stress-test.md.
describe("roleFuzzyMatch — real harvested ATS titles (stress-test report 2026-07-17)", () => {
  // §3.1, the dominant FN cause (~500+): "<Role>, <Department/Geo/Program>".
  // 80 of the 94 labeled product-manager titles failed exactly like this.
  it('matches the "<Role>, <Department>" form (Stripe: "Product Manager, Cash Platform")', () => {
    expect(roleFuzzyMatch(target(["Product Manager"]), posting("Product Manager, Cash Platform"))).toBe(true);
  });

  // §3.1: all 14 real Chief-of-Staff postings rejected at J=0.25 despite full
  // containment. Bjak carries the only real CoS/CEO postings in the sample.
  it('matches a real Chief-of-Staff posting (Bjak: "Chief of Staff - AI Neobank App (Singapore)")', () => {
    expect(
      roleFuzzyMatch(target(["Chief of Staff"]), posting("Chief of Staff - AI Neobank App (Singapore)")),
    ).toBe(true);
  });

  // §3.2: single-token roles under the Jaccard floor. "Technical Recruiter" is a
  // LITERAL sub-phrase of nothing — it is the posting; the résumé title is the
  // single token — and rejected at 0.50. Recruiter recall was 0.00 across all
  // 47 real recruiter titles. Head-noun path.
  it('matches a single-token role against its qualified posting (ElevenLabs: "Technical Recruiter")', () => {
    expect(roleFuzzyMatch(target(["Recruiter"]), posting("Technical Recruiter"))).toBe(true);
  });

  it('matches a single-token role across a segment separator (Ramp: "Senior Recruiter | Design")', () => {
    expect(roleFuzzyMatch(target(["Recruiter"]), posting("Senior Recruiter | Design"))).toBe(true);
  });

  // §3.3: Bjak's country-parenthetical pattern (×23 countries per role) plus the
  // developer→engineer fold. Both tokens are baseline, so no discriminating
  // overlap is possible and "engineer" ≠ "developer" broke the old bag test.
  it('matches the developer→engineer fold under a country suffix (Bjak: "Backend Developer (Philippines)")', () => {
    expect(roleFuzzyMatch(target(["Backend Engineer"]), posting("Backend Developer (Philippines)"))).toBe(true);
  });

  // §3.4: the interposed baseline token (~90 FNs, mobile recall was 0.21).
  // "Software" sits between "iOS" and "Engineer"; it is BASELINE_TOKENS, so the
  // phrase test skips it.
  it('matches across an interposed baseline token (Bjak: "iOS Software Engineer - AI Neobank App (Austria)")', () => {
    expect(
      roleFuzzyMatch(target(["iOS Engineer"]), posting("iOS Software Engineer - AI Neobank App (Austria)")),
    ).toBe(true);
  });

  // --- Negative pins for the FP classes the report names (§4) ---------------

  // §4.1: the word-order-blind bag containment matched {platform, engineer}
  // anywhere in the title — 55 FPs on this one target, including this manager
  // role. Replacing the bag test with ORDERED phrase containment is what
  // removes them; "engineer" precedes "platform" here, so no phrase match.
  it('rejects word-scattered bag containment (Stripe: "ML Engineer Manager, AI Conversation Platform")', () => {
    expect(
      roleFuzzyMatch(target(["Platform Engineer"]), posting("ML Engineer Manager, AI Conversation Platform")),
    ).toBe(false);
  });

  // §4.2 — HONEST PIN: this MATCHES, and it is a false positive. The phrase path
  // correctly rejects it ("marketing" is not baseline, so it is not a legal
  // skip), but the untouched TOKEN rule admits it: {product, manager} ∩
  // {product, marketing, manager} = 2/3 = J=0.67 ≥ 0.6. Pre-existing (the
  // donor's rule, not introduced by the phrase path) and low volume (~15 FPs);
  // fixing it means moving the Jaccard floor, which the report measured as
  // strictly worse (J≥0.5 → +120 FPs). Pinned as-is so the behaviour is visible
  // rather than assumed, and so a future fix has a fixture to flip.
  it('MATCHES a J=0.67 modifier collision — known FP, token path (Stripe: "Product Marketing Manager")', () => {
    expect(roleFuzzyMatch(target(["Product Manager"]), posting("Product Marketing Manager"))).toBe(true);
  });

  // §6.1 rule 3: the head-noun path is head-FINAL, not "token appears anywhere".
  it("head-noun path does not match when the role token is not the segment head", () => {
    expect(roleFuzzyMatch(target(["Recruiter"]), posting("Recruiting Coordinator"))).toBe(false);
    expect(roleFuzzyMatch(target(["CEO"]), posting("Executive Assistant to CEO"))).toBe(false);
    expect(roleFuzzyMatch(target(["CEO"]), posting("CEO Office - Business Operations"))).toBe(false);
  });
});

// Alias-expanded target, exactly as deriveRoleTargets builds it. Synonym rules
// live at deriveRoleTargets (via roleSynonyms.expandRoleTitles), NOT inside
// roleFuzzyMatch, so these fixtures must expand first — bare target() would
// bypass the table.
function expanded(titles: string[], keywords: string[] = []) {
  return { titles: expandRoleTitles(titles), keywords, persona: "remote" as const };
}

// The 4-entry fold table (tiers report 2026-07-17 §3), extending the shipped
// developer→engineer fold. Each fold is pinned BOTH ways over the real corpus: a
// verbatim title it must now MATCH via the fold, and a near-miss it must still
// reject. Tested through the RAW matcher (no synonym expansion) so the fold is
// the only thing under test; every posting is quoted from live-titles.json.
describe("roleFuzzyMatch — role-word folds (tiers report 2026-07-17 §3)", () => {
  const folds: Array<[fold: string, resumeTitle: string, matchPosting: string, nearMissPosting: string]> = [
    // accounting→account AND accountant→account: the "Accountant" résumé folds to
    // "account", the "Corporate Accounting" posting folds to "account" (head-noun).
    ["accounting/accountant→account", "Accountant", "Corporate Accounting", "Account Executive"],
    // partnerships→partnership: plural/singular unified ("Partnerships Manager"
    // résumé ≡ "Brand Partnership Manager" posting).
    ["partnerships→partnership", "Partnerships Manager", "Brand Partnership Manager", "People Partner"],
    // management→manager: folds INTO BASELINE — an "…Management" tail is altitude,
    // not a distinct role.
    ["management→manager", "Account Manager", "Head of Account Management", "Senior Director, Enterprise Risk Management"],
  ];

  for (const [fold, resumeTitle, matchPosting, nearMissPosting] of folds) {
    it(`${fold}: "${resumeTitle}" matches "${matchPosting}"`, () => {
      expect(roleFuzzyMatch(target([resumeTitle]), posting(matchPosting))).toBe(true);
    });
    it(`${fold}: "${resumeTitle}" does not admit "${nearMissPosting}"`, () => {
      expect(roleFuzzyMatch(target([resumeTitle]), posting(nearMissPosting))).toBe(false);
    });
  }
});

// The curated synonym table (tiers report 2026-07-17 §4) — 10 strict + 8 sibling
// rules. Each rule is pinned BOTH ways: a verbatim corpus posting the alias now
// admits, and a plausible verbatim near-miss the table must still reject (so a
// rule cannot silently over-match later). All titles are quoted from
// live-titles.json.
describe("roleFuzzyMatch — curated synonym expansion (tiers report 2026-07-17 §4)", () => {
  const rules: Array<[rule: string, resumeTitle: string, matchPosting: string, nearMissPosting: string]> = [
    // -- strict (same role, different name) --
    ["recruiter", "Recruiter", "Talent Acquisition Partner", "Recruiting Coordinator"],
    ["accountant", "Accountant", "Corporate Accounting", "Account Executive"],
    ["engineering manager", "Engineering Manager", "Engineering Lead, Billing", "Product Manager"],
    ["solutions/sales engineer", "Solutions Engineer", "Solutions Architect", "Data Platform Principal Architect"],
    ["sdr", "Sales Development Representative", "Business Development Representative - Enterprise", "Business Development Manager"],
    ["account executive", "Account Executive", "Sales Executive, Enterprise Accounts", "Executive Assistant to CEO"],
    ["legal/corporate counsel", "Corporate Counsel", "Corporate Paralegal", "Contract Finance Executive - GL (6 months)"],
    ["compliance", "Compliance Manager", "Manager, Regulatory Compliance, Vietnam", "Product Manager"],
    ["risk (strict)", "Risk Analyst", "Risk Operations Analyst - SSO", "Data Analyst"],
    ["people ops / hr", "People Operations Manager", "People Partner", "Product Manager"],
    // -- sibling (same function, different specialization/grade) --
    ["product designer", "Product Designer", "Brand Designer", "Design Engineer"],
    ["marketing manager", "Marketing Manager", "Head of Product Marketing", "Product Manager"],
    ["customer success manager", "Customer Success Manager", "Customer Success Architect", "Customer Activation Manager | Enterprise"],
    ["support", "Customer Support Specialist", "Product Support Specialist", "Product Manager"],
    ["operations manager", "Operations Manager", "Bridge Operations Associate", "Product Manager"],
    ["partnerships manager", "Partnerships Manager", "Director, Strategic Partnerships", "Product Manager"],
    ["content", "Content Writer", "Content Lead", "Design Systems Lead"],
    ["risk (sibling)", "Risk Manager", "Fraud Operations Manager", "Engineering Manager"],
  ];

  for (const [rule, resumeTitle, matchPosting, nearMissPosting] of rules) {
    it(`${rule}: "${resumeTitle}" now matches "${matchPosting}"`, () => {
      expect(roleFuzzyMatch(expanded([resumeTitle]), posting(matchPosting))).toBe(true);
    });
    it(`${rule}: "${resumeTitle}" does not admit "${nearMissPosting}"`, () => {
      expect(roleFuzzyMatch(expanded([resumeTitle]), posting(nearMissPosting))).toBe(false);
    });
  }

  // Extra verbatim MATCH pins for the highest-volume aliases.
  it('recruiter alias admits "Sr. Technical Sourcer" (Perplexity)', () => {
    expect(roleFuzzyMatch(expanded(["Recruiter"]), posting("Sr. Technical Sourcer"))).toBe(true);
  });
  it('account-executive alias admits "Client Sales Representative" (Toptal)', () => {
    expect(roleFuzzyMatch(expanded(["Account Executive"]), posting("Client Sales Representative"))).toBe(true);
  });
  it('marketing alias admits "Digital Marketing Executive" (Bjak)', () => {
    expect(roleFuzzyMatch(expanded(["Marketing Manager"]), posting("Digital Marketing Executive"))).toBe(true);
  });
});

// Trigger-hygiene: the two bugs the report found and fixed during measurement
// (§4). A specialization résumé must NOT inherit the generalist expansion — the
// negative lookbehinds in roleSynonyms.ts are what prevent it.
describe("expandRoleTitles — trigger hygiene (tiers report 2026-07-17 §4)", () => {
  it('"Content Marketing Manager" does not inherit the generalist marketing expansion', () => {
    const out = expandRoleTitles(["Content Marketing Manager"]);
    expect(out).not.toContain("Growth Marketing");
    expect(out).not.toContain("Performance Marketing");
    // it still gets its OWN content aliases
    expect(out).toContain("Content Lead");
  });

  it('"People Operations Manager" does not inherit the operations-manager expansion', () => {
    const out = expandRoleTitles(["People Operations Manager"]);
    expect(out).not.toContain("Operations Associate");
    expect(out).not.toContain("Strategy Operations");
    // it still gets its OWN people aliases
    expect(out).toContain("People Partner");
  });
});

describe("roleTokens", () => {
  it("drops stopwords and short generic words, keeps short specialty acronyms", () => {
    expect(roleTokens("Senior Remote QA Engineer")).toEqual(["qa", "engineer"]);
  });

  it("keeps role acronyms (function-agnostic short-token retention)", () => {
    expect(roleTokens("CEO")).toEqual(["ceo"]);
    expect(roleTokens("VP of Marketing")).toEqual(["vp", "marketing"]);
  });

  it("drops function-neutral glue words admitted by the >=2 length rule", () => {
    expect(roleTokens("Head of Finance and Operations for the APAC Team")).toEqual(["finance", "operations"]);
  });

  it("keeps 'staff' as the function token of Chief of Staff", () => {
    expect(roleTokens("Chief of Staff")).toEqual(["staff"]);
  });

  it("drops abbreviated seniority and roman-numeral levels (punctuation is stripped first)", () => {
    expect(roleTokens("Sr. Software Engineer")).toEqual(["software", "engineer"]);
    expect(roleTokens("Jr. Software Engineer")).toEqual(["software", "engineer"]);
    expect(roleTokens("Software Engineer II")).toEqual(["software", "engineer"]);
    expect(roleTokens("Software Engineer III")).toEqual(["software", "engineer"]);
    expect(roleTokens("Software Engineer IV")).toEqual(["software", "engineer"]);
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

  it("no longer falls back to a contact headline line (contact-regex fallback removed — store.headline is the only best-effort source)", () => {
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
    expect(target.titles).toEqual(["Senior Backend Engineer"]);
  });

  it("uses store.headline directly when present, over a contact headline line", () => {
    const resume = {
      structured: {
        storeVersion: 2 as const,
        extractionPath: "text" as const,
        name: "Jane Doe",
        headline: "Staff Platform Engineer",
        contact: [{ label: "headline", value: "Some Other Title" }],
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

  it("falls back to experience titles when store.headline is absent", () => {
    const resume = {
      structured: {
        storeVersion: 2 as const,
        extractionPath: "text" as const,
        name: "Jane Doe",
        contact: [],
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
    expect(target.titles).toEqual(["Senior Backend Engineer"]);
  });
});
