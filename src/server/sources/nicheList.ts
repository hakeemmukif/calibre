// Niche-list ingest — the head of the company-list pipeline.
//
// The design's §4.3 "join jobhive against the niche lists on normalized
// domain" is a 0-row join in practice: jobhive's `url` column is always the
// ATS board URL, so all 9,935 rows resolve to just 3 vendor hosts
// (boards.greenhouse.io, jobs.lever.co, jobs.ashbyhq.com) and can never match
// a company domain. The pipeline is therefore inverted: the niche lists DRIVE
// and jobhive becomes an (ats, slug) lookup keyed off the company.
//
// That makes this module the only source of `companyDomain` in the dataset —
// jobhive has none and the ATS APIs return none — and both seedFromEngine and
// freshness.ts hard-require it. Hence `website` is load-bearing here, not
// decorative.
//
// Sources (verified live 2026-07-17):
//  - yc-oss: https://yc-oss.github.io/api/companies/all.json, 6,050 records,
//    `website` populated 6,015/6,050 (99.4%). It has NO careers/jobs URL
//    field — its `url` is the YC directory page, not a careers page — so
//    careersUrl is never set from this source. Licence: the repo has NO
//    LICENSE file (`license: null` via the GitHub API); using it is the
//    operator's risk call, already flagged in the design.
//  - remoteintech/remote-jobs: RESTRUCTURED since the design was written — no
//    longer a README markdown table, now 881 `src/companies/*.md` files with
//    YAML frontmatter (title, slug, website, careers_url, region,
//    remote_policy, company_size, technologies). Every .md in the live
//    snapshot has a `website`; `careers_url` is on 611/881 (69.2%). Licence:
//    ISC (the design's "NOASSERTION" is stale).
//  - topstartups.io: DROPPED, do not ingest. It returns HTTP 403 to
//    non-browser clients, has no API/export, and its terms are UNKNOWN.
//    Design §7 makes any 403 a stop signal and forbids spoofing a browser UA.
//    Any reference to it in the plan/spec is superseded.
//
// Whether the full datasets get vendored into the repo or fetched at runtime
// is an OPERATOR decision and is deliberately not made here — this module is
// the parser only. The fixtures under __fixtures__/ are small real samples.
import { parse } from "yaml";
import { normalizeDomain } from "./nicheFilter";

export type NicheProvenance = "yc-oss" | "remoteintech";

export interface NicheCompany {
  /** Verbatim from the source — never normalized; domain is the join key. */
  name: string;
  /** Normalized bare domain from the source's `website`. Becomes companyDomain. */
  domain: string;
  provenance: NicheProvenance;
  /** yc-oss only; absent for remoteintech (which carries no hiring signal). */
  isHiring?: boolean;
  /** remoteintech only (69.2% populated); absent for yc-oss (which has no such field). */
  careersUrl?: string;
}

// A record whose `website` is missing/unparseable is skipped, counted, and
// warned about — not thrown on, and never silently dropped.
//
// Fail-loud governs *corruption*: a payload that isn't an array, or a record
// with no `name`, means the source's shape changed and every downstream
// assumption is void — those throw. An absent `website` is different: it is a
// known, measured property of the source (0.6% of yc-oss are defunct
// companies like "Assembled", whose website is ""), not a signal that parsing
// went wrong. Throwing would let 35 dead companies deny the other 6,015 —
// a fallback in the opposite direction, trading a silent wrong answer for a
// total outage. Such a record simply cannot yield a NicheCompany: no website
// means no domain means no companyDomain, and defaulting the domain to ""
// would poison the join key that the whole inverted pipeline rests on.
function reportSkipped(source: string, skipped: string[], total: number): void {
  if (skipped.length === 0) return;
  console.warn(
    `${source}: skipped ${skipped.length} of ${total} record(s) with a missing/unparseable website ` +
      `(no domain = no companyDomain downstream): ${skipped.join("; ")}`,
  );
}

/** Parses the yc-oss `companies/all.json` payload. */
export function parseYcOss(json: unknown): NicheCompany[] {
  if (!Array.isArray(json)) {
    throw new Error(`parseYcOss: expected an array of company records, got ${json === null ? "null" : typeof json}`);
  }

  const companies: NicheCompany[] = [];
  const skipped: string[] = [];

  for (const [index, record] of json.entries()) {
    if (typeof record !== "object" || record === null) {
      throw new Error(`parseYcOss: record ${index} is not an object (got ${JSON.stringify(record)})`);
    }

    const { name, website, isHiring } = record as { name?: unknown; website?: unknown; isHiring?: unknown };

    if (typeof name !== "string" || name.trim() === "") {
      throw new Error(`parseYcOss: record ${index} is missing a name (got ${JSON.stringify(name)})`);
    }
    if (typeof isHiring !== "boolean") {
      throw new Error(`parseYcOss: record ${index} ("${name}") is missing the boolean isHiring (got ${JSON.stringify(isHiring)})`);
    }

    let domain: string;
    try {
      domain = normalizeDomain(website as string);
    } catch {
      skipped.push(name);
      continue;
    }

    companies.push({ name, domain, provenance: "yc-oss", isHiring });
  }

  reportSkipped("parseYcOss", skipped, json.length);
  return companies;
}

/**
 * Parses remoteintech/remote-jobs `src/companies/*.md` files. The caller
 * chooses the files — the source directory also holds non-.md files
 * (companies.json, companies.11tydata.js) which have no frontmatter and would
 * fail loud here.
 */
export function parseRemoteInTech(files: { path: string; content: string }[]): NicheCompany[] {
  if (!Array.isArray(files)) {
    throw new Error(`parseRemoteInTech: expected an array of files, got ${files === null ? "null" : typeof files}`);
  }

  const companies: NicheCompany[] = [];
  const skipped: string[] = [];

  for (const { path, content } of files) {
    const frontmatter = parseFrontmatter(path, content);
    const { title, website, careers_url: careersUrl } = frontmatter;

    if (typeof title !== "string" || title.trim() === "") {
      throw new Error(`parseRemoteInTech: "${path}" is missing a title (got ${JSON.stringify(title)})`);
    }

    let domain: string;
    try {
      domain = normalizeDomain(website as string);
    } catch {
      skipped.push(path);
      continue;
    }

    const company: NicheCompany = { name: title, domain, provenance: "remoteintech" };
    if (typeof careersUrl === "string" && careersUrl.trim() !== "") {
      company.careersUrl = careersUrl;
    }
    companies.push(company);
  }

  reportSkipped("parseRemoteInTech", skipped, files.length);
  return companies;
}

// Frontmatter values are quoted strings, bare URLs containing colons, YAML
// lists, and dates — a hand-rolled `key: value` splitter would mis-read them,
// so this uses the `yaml` parser already depended on by src/lib/llm/models.ts.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

function parseFrontmatter(path: string, content: string): Record<string, unknown> {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    throw new Error(`parseRemoteInTech: "${path}" has no YAML frontmatter`);
  }

  const parsed: unknown = parse(match[1]);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`parseRemoteInTech: "${path}" frontmatter is not a key/value mapping`);
  }

  return parsed as Record<string, unknown>;
}
