// Company-list engine, match step — the design's §4.3 step 2 INVERTED.
//
// §4.3 step 2 says "join jobhive rows against yc-oss/remoteintech on
// normalized domain, never company name". That join provably matches 0 rows
// and is deleted here. A live probe of the real data (2026-07-17) showed
// jobhive's `url` column is ALWAYS the ATS board URL — jobhive's own README
// calls it "the canonical public careers URL" by design — so all 9,935 rows
// normalize to exactly 3 vendor hosts (job-boards.greenhouse.io 4,966/4,966,
// jobs.lever.co 2,113/2,113, jobs.ashbyhq.com 2,856/2,856). There is no
// company-domain column in jobhive and there never was; the intersection with
// company websites is literally empty.
//
// So the pipeline inverts: the NICHE LISTS DRIVE and jobhive becomes an
// (ats, slug) lookup keyed off the company. The niche list is therefore the
// only source of `companyDomain` in the dataset (seedFromEngine hard-requires
// it), which is why it rides on every candidate.
//
// Measured full-population yield of THIS function over the real data
// (9,935 jobhive rows; candidate counts are post-dedupe, i.e. seedable rows):
//   yc-oss Active (4,170 w/ domain): 656 candidates (15.7%) — 422 domain-stem, 234 name
//   yc-oss Active+isHiring (1,488):  425 candidates (28.6%)
//   remoteintech (881):              228 candidates (25.9%) — 188 domain-stem, 40 name
//   BOTH lists, deduped:             861 candidates — 588 domain-stem, 273 name
// So ~860 companies, NOT the design's "1,500-4,000" (and under the ~1,000-1,100
// estimated pre-dedupe: several niche companies collapse onto one slug).
// Nothing here is tuned to reach a target; the number is what it is.
//
// Deliberately does NOT pre-filter for remote-only (§4.3 step 2 is still
// correct on this point: "seed the company and let the existing per-posting
// geo filter decide visibility per posting"), and deliberately does NOT
// filter on `isHiring` — it is a snapshot, and a company not hiring today
// posts tomorrow. `isHiring` stays on NicheCompany, available to the operator
// for ramp-ordering; this module never reads it.
//
// Matching is NOT identity verification. Both keys produce verified false
// positives on real data (see nicheFilter.test.ts: yc's Affinity is
// itsaffinity.com, not jobhive's Affinity.co; yc's Porter is porter.run, not
// lever/porter's "Porter Cares, Inc."). `matchMethod` is surfaced so
// identity.ts can adjudicate — it is not a claim that the match is correct.
import type { JobhiveAts, JobhiveRow } from "./jobhive";
// Type-only: nicheList.ts imports normalizeDomain from here, so a value
// import would close a runtime cycle. Types are erased.
import type { NicheCompany, NicheProvenance } from "./nicheList";

/**
 * Normalizes a URL (or bare domain) down to its host for use as a join key:
 * strip scheme, strip a leading "www.", drop path/query/fragment, lowercase.
 * Fails loud on missing/unparseable input — no silent skip, no defaulting.
 */
export function normalizeDomain(rawUrl: string): string {
  const trimmed = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!trimmed) {
    throw new Error(`normalizeDomain: missing/empty url (got ${JSON.stringify(rawUrl)})`);
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let host: string;
  try {
    host = new URL(withScheme).hostname;
  } catch {
    throw new Error(`normalizeDomain: could not parse a domain from "${rawUrl}"`);
  }

  if (!host) {
    throw new Error(`normalizeDomain: could not parse a domain from "${rawUrl}"`);
  }

  const lower = host.toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

/** How a candidate matched. "domain-stem" is the stronger signal — but see the false positives. */
export type MatchMethod = "domain-stem" | "name";

export interface EngineCandidate {
  /** The jobhive row's name — the ATS board's own identity (seedFromEngine writes it as the source name). */
  name: string;
  slug: string;
  ats: JobhiveAts;
  /** From the NicheCompany — the ONLY source of this value in the data. */
  companyDomain: string;
  /** Which list(s) claimed this company; a company can be in both. */
  provenance: NicheProvenance[];
  matchMethod: MatchMethod;
}

// Suffix tokens stripped from a company name before comparison. DERIVED FROM
// REAL DATA, not imagination — two evidence sources over the live probe:
//
// 1. Trailing-token frequency across the real 9,935 jobhive names:
//    inc 298, ai 170, group 129, labs 103, technologies 70, llc 65,
//    solutions 45, systems 36, corporation 35, company 33, services 29,
//    technology 23, io 20, software 20, gmbh 18.
// 2. Measured MARGINAL name-match gain of each candidate token over the
//    legal-suffix base, across yc-oss Active + remoteintech (5,060 companies):
//      ai +31, labs +15, technologies +7, io +7, systems +5, tech +4,
//      software +4, com +3, ventures +3, careers +2, lab +2, technology +2,
//      partners +1, app +1, media +1,
//      solutions +0, services +0, group +0, holdings +0, global +0, digital +0.
//
// Tokens measuring +0 are excluded — no evidence, and each one only widens the
// false-positive surface. Frequent-but-industry words (health 186, energy 34,
// robotics 29, therapeutics 17, bank 18) are excluded on principle: they carry
// meaning ("Ro Health" is not "Ro"), and stripping them invents collisions.
// Singular/plural pairs are kept together as one rule rather than split on a
// marginal-gain threshold.
const LEGAL_SUFFIXES = [
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "llc",
  "ltd",
  "limited",
  "co",
  "company",
  "pbc",
  "plc",
  "gmbh",
];
const DESCRIPTIVE_SUFFIXES = ["ai", "labs", "lab", "technologies", "technology", "tech", "software", "systems", "io"];
const NAME_SUFFIXES = new Set([...LEGAL_SUFFIXES, ...DESCRIPTIVE_SUFFIXES]);

/**
 * Normalized name key. Suffix stripping ITERATES: real data has
 * "Canary Technologies Corp" (jobhive) against "Canary Technologies"
 * (yc-oss). One pass strips only `Corp`, leaving "canary technologies", while
 * the yc side reduces to "canary" — a miss. Iterating strips `Corp` then
 * `Technologies` and both converge on "canary".
 *
 * Never strips the last remaining token: a company literally named "Labs" or
 * "Co" must keep its name rather than reduce to "".
 */
function nameKey(rawName: string): string {
  const tokens = rawName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  while (tokens.length > 1 && NAME_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }

  return tokens.join("");
}

/** Slug/stem comparison key — real slugs vary in punctuation ("canary-technologies" vs "canarytechnologies"). */
function slugKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** `ramp.com` -> `ramp`. The niche `domain` is already a normalized bare domain (nicheList.ts). */
function domainStem(domain: string): string {
  return slugKey(domain.split(".")[0]);
}

/**
 * Matches niche companies against the jobhive (ats, slug) lookup and returns
 * the seedable candidates. Two keys, both needed — measured over the full
 * yc-oss Active population, name alone and domain-stem alone each find
 * companies the other misses:
 *   1. domain-stem: the company's `domain` stem vs the jobhive `slug`.
 *   2. name: iterated-suffix-stripped company name vs the jobhive `name`.
 * `domain-stem` wins `matchMethod` when both hit — it is the stronger signal.
 *
 * De-duped on jobhive `slug`: one slug yields at most one candidate, and a
 * company claimed by both niche lists merges into one candidate with both
 * provenances (in niche-list input order). Fails loud on a missing domain,
 * name, or slug — never skips a bad record silently.
 */
export function matchNicheToJobhive(niche: NicheCompany[], jobhive: JobhiveRow[]): EngineCandidate[] {
  const bySlugKey = new Map<string, JobhiveRow>();
  const byNameKey = new Map<string, JobhiveRow>();

  for (const row of jobhive) {
    if (!row.slug.trim()) {
      throw new Error(`matchNicheToJobhive: jobhive row "${row.name}" (${row.ats}) has an empty slug`);
    }
    if (!row.name.trim()) {
      throw new Error(`matchNicheToJobhive: jobhive row ${row.ats}:${row.slug} has an empty name`);
    }
    // First row wins for a repeated key — two ATS vendors really do share a
    // slug on real data (greenhouse/affinity "Affinity.co" vs ashby/affinity
    // "Affinity Analytics"), and one slug must not yield two candidates.
    const slugK = slugKey(row.slug);
    if (!bySlugKey.has(slugK)) bySlugKey.set(slugK, row);

    const nameK = nameKey(row.name);
    if (nameK && !byNameKey.has(nameK)) byNameKey.set(nameK, row);
  }

  const candidates = new Map<string, EngineCandidate>();

  for (const company of niche) {
    if (!company.domain.trim()) {
      throw new Error(`matchNicheToJobhive: niche company "${company.name}" (${company.provenance}) has an empty domain`);
    }
    if (!company.name.trim()) {
      throw new Error(`matchNicheToJobhive: niche company from ${company.provenance} (${company.domain}) has an empty name`);
    }

    const byDomain = bySlugKey.get(domainStem(company.domain));
    const byName = byNameKey.get(nameKey(company.name));
    const row = byDomain ?? byName;
    if (!row) continue;

    const key = slugKey(row.slug);
    const existing = candidates.get(key);
    if (existing) {
      if (!existing.provenance.includes(company.provenance)) existing.provenance.push(company.provenance);
      continue;
    }

    candidates.set(key, {
      name: row.name,
      slug: row.slug,
      ats: row.ats,
      companyDomain: company.domain,
      provenance: [company.provenance],
      matchMethod: byDomain ? "domain-stem" : "name",
    });
  }

  return [...candidates.values()];
}
