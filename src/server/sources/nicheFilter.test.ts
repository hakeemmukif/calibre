// The design's §4.3 step 2 join ("join jobhive against the niche lists on
// normalized domain") is dead: a live probe of the real data showed jobhive's
// `url` is ALWAYS the ATS board URL, so all 9,935 rows normalize to exactly 3
// vendor hosts and the intersection with company websites is 0 rows. The
// pipeline is inverted here — the niche lists drive, jobhive is an (ats, slug)
// lookup. The old `filterNicheRows` join tests are deleted with the function.
//
// Every fixture below is REAL data from the live probe (yc-oss all.json +
// the three jobhive CSVs), not invented shapes — including the two verified
// false-positive counterexamples, which are pinned as-is rather than fudged.
import { describe, expect, it } from "vitest";
import type { JobhiveRow } from "./jobhive";
import type { NicheCompany } from "./nicheList";
import { matchNicheToJobhive, normalizeDomain } from "./nicheFilter";

describe("normalizeDomain", () => {
  it("strips the scheme", () => {
    expect(normalizeDomain("https://vercel.com/careers")).toBe("vercel.com");
    expect(normalizeDomain("http://vercel.com")).toBe("vercel.com");
  });

  it("strips a leading www.", () => {
    expect(normalizeDomain("https://www.vercel.com")).toBe("vercel.com");
  });

  it("accepts a bare domain with no scheme", () => {
    expect(normalizeDomain("vercel.com")).toBe("vercel.com");
  });

  it("strips path, query, and fragment", () => {
    expect(normalizeDomain("https://vercel.com/jobs?ref=abc&utm_source=x#top")).toBe("vercel.com");
  });

  it("lowercases scheme/www/host case variants", () => {
    expect(normalizeDomain("HTTPS://WWW.Vercel.COM/Careers")).toBe("vercel.com");
  });

  it("throws on an empty string", () => {
    expect(() => normalizeDomain("")).toThrow();
  });

  it("throws on a missing/undefined value", () => {
    expect(() => normalizeDomain(undefined as unknown as string)).toThrow();
  });

  it("throws on an unparseable URL", () => {
    expect(() => normalizeDomain("http://")).toThrow();
    expect(() => normalizeDomain("not a url at all??")).toThrow();
  });
});

// --- real rows, verbatim from the probe's jobhive CSVs -----------------

const CANARY_TECHNOLOGIES: JobhiveRow = {
  name: "Canary Technologies Corp",
  slug: "canarytechnologies",
  ats: "lever",
  url: "https://jobs.lever.co/canarytechnologies",
};
const AFFINITY_CO: JobhiveRow = {
  name: "Affinity.co",
  slug: "affinity",
  ats: "greenhouse",
  url: "https://job-boards.greenhouse.io/affinity",
};
const PORTER_CARES: JobhiveRow = {
  name: "Porter Cares, Inc.",
  slug: "porter",
  ats: "lever",
  url: "https://jobs.lever.co/porter",
};
const RAMP: JobhiveRow = {
  name: "Ramp",
  slug: "ramp",
  ats: "ashby",
  url: "https://jobs.ashbyhq.com/ramp",
};

describe("matchNicheToJobhive", () => {
  it("matches a niche company's domain stem to the jobhive slug", () => {
    const niche: NicheCompany[] = [{ name: "Ramp", domain: "ramp.com", provenance: "yc-oss" }];

    expect(matchNicheToJobhive(niche, [RAMP])).toEqual([
      {
        name: "Ramp",
        slug: "ramp",
        ats: "ashby",
        companyDomain: "ramp.com",
        provenance: ["yc-oss"],
        matchMethod: "domain-stem",
      },
    ]);
  });

  it("yields nothing when neither the domain stem nor the name matches", () => {
    const niche: NicheCompany[] = [{ name: "Vercel", domain: "vercel.com", provenance: "yc-oss" }];

    expect(matchNicheToJobhive(niche, [RAMP])).toEqual([]);
  });

  // The whole reason the join inverted: jobhive's url is the ATS board host,
  // never the company's. It must never be used as a join key.
  it("never joins on the jobhive row's ATS-host url (the deleted domain join)", () => {
    const vendorHosts: NicheCompany[] = [
      { name: "Greenhouse", domain: "job-boards.greenhouse.io", provenance: "yc-oss" },
      { name: "Lever", domain: "jobs.lever.co", provenance: "yc-oss" },
      { name: "Ashby", domain: "jobs.ashbyhq.com", provenance: "yc-oss" },
    ];

    expect(matchNicheToJobhive(vendorHosts, [RAMP, PORTER_CARES, AFFINITY_CO])).toEqual([]);
  });

  // REAL case: yc-oss "Canary Technologies" vs jobhive "Canary Technologies
  // Corp". A naive single-pass strip leaves "canary technologies" on the
  // jobhive side but reduces the yc name to "canary" — a miss. Iterating
  // (Corp, then Technologies) converges both to "canary".
  it("matches on name via ITERATED suffix stripping (Canary Technologies / Canary Technologies Corp)", () => {
    const niche: NicheCompany[] = [
      { name: "Canary Technologies", domain: "canarytechnologies.com", provenance: "yc-oss" },
    ];

    const [candidate] = matchNicheToJobhive(niche, [CANARY_TECHNOLOGIES]);
    expect(candidate.slug).toBe("canarytechnologies");
    expect(candidate.companyDomain).toBe("canarytechnologies.com");
  });

  it("matches on name alone when the company domain bears no relation to the slug", () => {
    const niche: NicheCompany[] = [{ name: "Canary Technologies", domain: "trycanary.io", provenance: "yc-oss" }];

    expect(matchNicheToJobhive(niche, [CANARY_TECHNOLOGIES])).toEqual([
      {
        name: "Canary Technologies Corp",
        slug: "canarytechnologies",
        ats: "lever",
        companyDomain: "trycanary.io",
        provenance: ["yc-oss"],
        matchMethod: "name",
      },
    ]);
  });

  it("prefers matchMethod domain-stem when both keys hit", () => {
    const niche: NicheCompany[] = [
      { name: "Canary Technologies", domain: "canarytechnologies.com", provenance: "yc-oss" },
    ];

    expect(matchNicheToJobhive(niche, [CANARY_TECHNOLOGIES])[0].matchMethod).toBe("domain-stem");
  });

  it("de-dupes a company present in both niche lists into ONE candidate with merged provenance", () => {
    const niche: NicheCompany[] = [
      { name: "Ramp", domain: "ramp.com", provenance: "yc-oss", isHiring: true },
      { name: "Ramp", domain: "ramp.com", provenance: "remoteintech", careersUrl: "https://ramp.com/careers" },
    ];

    const candidates = matchNicheToJobhive(niche, [RAMP]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].provenance).toEqual(["yc-oss", "remoteintech"]);
  });

  it("never emits two candidates for one jobhive slug", () => {
    const affinityAshby: JobhiveRow = { ...AFFINITY_CO, name: "Affinity Analytics", ats: "ashby", url: "https://jobs.ashbyhq.com/affinity" };
    const niche: NicheCompany[] = [{ name: "Affinity", domain: "itsaffinity.com", provenance: "yc-oss" }];

    const slugs = matchNicheToJobhive(niche, [AFFINITY_CO, affinityAshby]).map((c) => c.slug);
    expect(slugs).toEqual([...new Set(slugs)]);
  });

  it("gives every candidate a non-empty companyDomain (the niche list is its only source)", () => {
    const niche: NicheCompany[] = [
      { name: "Ramp", domain: "ramp.com", provenance: "yc-oss" },
      { name: "Canary Technologies", domain: "canarytechnologies.com", provenance: "remoteintech" },
    ];

    const candidates = matchNicheToJobhive(niche, [RAMP, CANARY_TECHNOLOGIES]);
    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) expect(candidate.companyDomain).not.toBe("");
  });

  it("does NOT filter on isHiring — a company not hiring today still seeds", () => {
    const niche: NicheCompany[] = [{ name: "Ramp", domain: "ramp.com", provenance: "yc-oss", isHiring: false }];

    expect(matchNicheToJobhive(niche, [RAMP])).toHaveLength(1);
  });

  it("does NOT pre-filter for remote — no remote signal is read at all", () => {
    const niche: NicheCompany[] = [{ name: "Porter Cares", domain: "portercares.com", provenance: "yc-oss" }];

    expect(matchNicheToJobhive(niche, [PORTER_CARES])).toHaveLength(1);
  });

  it("fails loud on a niche company with an empty domain", () => {
    const niche: NicheCompany[] = [{ name: "Ramp", domain: "", provenance: "yc-oss" }];

    expect(() => matchNicheToJobhive(niche, [RAMP])).toThrow(/domain/);
  });

  it("fails loud on a jobhive row with an empty slug", () => {
    const niche: NicheCompany[] = [{ name: "Ramp", domain: "ramp.com", provenance: "yc-oss" }];

    expect(() => matchNicheToJobhive(niche, [{ ...RAMP, slug: "" }])).toThrow(/slug/);
  });

  // --- verified false positives, documented not hidden -------------------
  // identity.ts (a separate module) consumes matchMethod to catch these. The
  // assertions below record what this matcher ACTUALLY does today.

  it("FALSE POSITIVE (documented): yc-oss Affinity (itsaffinity.com) name-matches jobhive Affinity.co — a different company", () => {
    const niche: NicheCompany[] = [{ name: "Affinity", domain: "itsaffinity.com", provenance: "yc-oss" }];

    // "Affinity.co" -> tokens [affinity, co] -> `co` is a legal suffix -> "affinity".
    expect(matchNicheToJobhive(niche, [AFFINITY_CO])).toEqual([
      {
        name: "Affinity.co",
        slug: "affinity",
        ats: "greenhouse",
        companyDomain: "itsaffinity.com",
        provenance: ["yc-oss"],
        matchMethod: "name",
      },
    ]);
  });

  it("FALSE POSITIVE (documented): yc-oss Porter (porter.run) domain-stem-matches jobhive lever/porter, which is Porter Cares, Inc.", () => {
    const niche: NicheCompany[] = [{ name: "Porter", domain: "porter.run", provenance: "yc-oss" }];

    // domain-stem is the STRONGER signal and is still wrong here: stem
    // "porter" == slug "porter". matchMethod alone cannot clear a candidate.
    expect(matchNicheToJobhive(niche, [PORTER_CARES])).toEqual([
      {
        name: "Porter Cares, Inc.",
        slug: "porter",
        ats: "lever",
        companyDomain: "porter.run",
        provenance: ["yc-oss"],
        matchMethod: "domain-stem",
      },
    ]);
  });
});
