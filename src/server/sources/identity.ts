// Identity verification for a matched (ats, slug) candidate — does the board
// we matched actually BELONG to the company we think it does?
//
// Upstream matches niche-list companies (yc-oss, remoteintech) to jobhive ATS
// slugs by normalized name or domain-stem. That matching provably
// mis-attributes; three real cases found by a live probe on 2026-07-17:
//   - greenhouse "affinity" is "Affinity.co"        — YC's Affinity is itsaffinity.com
//   - ashby      "affinity" is "Affinity Analytics" — likewise not YC's Affinity
//   - lever      "porter"   is "Porter Cares, Inc." — YC's Porter is porter.run
// Seeding those feeds one company's jobs to users searching for another. This
// module bounds that by asking the vendor who the board belongs to, BEFORE we
// seed.
//
// Identity endpoints — all three verified live 2026-07-17. NOTE: an earlier
// probe concluded lever and ashby expose no identity signal. That is wrong; it
// only inspected the JSON posting APIs. Both expose identity on the public
// board PAGE:
//   greenhouse: https://boards-api.greenhouse.io/v1/boards/{slug}
//               -> {"name":"Stripe","content":""}                  (clean JSON)
//   lever:      https://jobs.lever.co/{slug}
//               -> <title>Porter Cares, Inc. </title>              (board page)
//               (api.lever.co/v0/postings/{slug} carries no org identity)
//   ashby:      https://jobs.ashbyhq.com/{slug}
//               -> embedded {"organization":{"name":"0g Labs","publicWebsite":"https://0g.ai/",...}}
//               (api.ashbyhq.com posting-api has only `jobs, apiVersion`, and
//                jobs.ashbyhq.com/robots.txt disallows /api/ — the board page
//                itself is allowed)
//
// robots: jobs.lever.co allows `User-agent: * / Allow: /`; jobs.ashbyhq.com
// disallows only /meeting/, /b/, /api/. Both board pages are permitted.

import type { FetchLike } from "./validate";

export type AtsKind = "greenhouse" | "lever" | "ashby";

export interface IdentityCandidate {
  /** The company we EXPECT this board to belong to, per the niche list. */
  name: string;
  slug: string;
  ats: AtsKind;
  /** The expected company's own domain, per the niche list (e.g. "itsaffinity.com"). */
  companyDomain: string;
  matchMethod: "domain-stem" | "name";
}

export type IdentityVerdict =
  | { status: "confirmed"; evidence: string }
  | { status: "mismatch"; evidence: string }
  | { status: "unverifiable"; reason: string };

export interface VerifyIdentityOptions {
  /** Injected fetch — never the global, so this stays a pure test double in unit tests. */
  fetch: FetchLike;
  /**
   * Slot hold time after each request, per host (design §7 politeness). The
   * limiter holds the slot this long before releasing it, so at concurrency 2
   * a host sees at most ~2 requests per this interval.
   */
  politenessDelayMs?: number;
}

const USER_AGENT = "Mozilla/5.0 (compatible; caliber-source-validator/1.0)";
const DEFAULT_POLITENESS_DELAY_MS = 250;

// Design §7 binding: ~2 concurrent per host. `verifyIdentity` is per-candidate,
// so callers fan out with Promise.all — the limiter must therefore be
// module-level to bound anything at all.
const MAX_CONCURRENT_PER_HOST = 2;

const STATUS_REASONS: Record<number, string> = {
  404: "not_found",
  403: "forbidden",
  429: "rate_limited",
};

// Legal-entity suffixes ONLY. Deliberately NOT descriptors like "Labs",
// "Analytics", "Technologies", "Network", "Cares" — stripping those is exactly
// what would let "Affinity Analytics" and "Porter Cares, Inc." pass as
// "Affinity" and "Porter". See normalizeCompanyName.
const LEGAL_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "llc",
  "lp",
  "llp",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "co",
  "company",
  "plc",
  "gmbh",
  "ag",
  "bv",
  "nv",
  "ab",
  "as",
  "asa",
  "oy",
  "oyj",
  "sa",
  "sas",
  "sarl",
  "srl",
  "spa",
  "pty",
  "pte",
  "sdn",
  "bhd",
  "kk",
  "kft",
  "aps",
]);

/**
 * The comparison rule.
 *
 * Lowercase -> strip diacritics -> split on whitespace/commas ONLY -> drop
 * trailing legal-entity suffix tokens -> join -> drop remaining punctuation.
 *
 * Why it rejects the Affinity case: we split on whitespace and commas but
 * NEVER on ".", so "Affinity.co" stays a single token. "co" is therefore never
 * seen as a standalone legal suffix and is not stripped, giving "affinityco" —
 * which is not equal to "affinity". A rule that split on "." (or that did
 * prefix/containment matching) would confirm this mis-attribution.
 *
 * Why it still accepts "Stripe" vs "Stripe, Inc.": there "Inc." IS a
 * standalone trailing token, so it is stripped, giving "stripe" == "stripe".
 *
 * Comparison is exact after normalization — no containment, no token-subset.
 * Both looser rules confirm real mis-attributions from our own data
 * ("Porter Cares" contains "Porter"; "Affinity Analytics" ⊃ "Affinity"). The
 * cost is some false mismatches ("Monzo" vs "Monzo Bank Limited"), which fail
 * in the safe direction: we decline to seed rather than mis-attribute.
 */
export function normalizeCompanyName(raw: string): string {
  const cleaned = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

  const tokens = cleaned.split(/[\s,]+/).filter(Boolean);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1].replace(/[^a-z0-9]/g, ""))) {
    tokens.pop();
  }
  return tokens.join("").replace(/[^a-z0-9]/g, "");
}

function hostOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

interface VendorIdentity {
  /** Vendor-reported org name, or null when the vendor exposed none. */
  name: string | null;
  /** Vendor-reported company website host, or null. Only ashby exposes this. */
  website: string | null;
}

function endpointFor(candidate: IdentityCandidate): { url: string; host: string } {
  const { slug, ats } = candidate;
  let url: string;
  switch (ats) {
    case "greenhouse":
      url = `https://boards-api.greenhouse.io/v1/boards/${slug}`;
      break;
    case "lever":
      url = `https://jobs.lever.co/${slug}`;
      break;
    case "ashby":
      url = `https://jobs.ashbyhq.com/${slug}`;
      break;
    default:
      throw new Error(`verifyIdentity: unknown ats kind "${String(ats)}" for slug "${slug}"`);
  }
  return { url, host: new URL(url).host };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;/gi, "'");
}

function parseGreenhouse(body: unknown): VendorIdentity {
  const name = (body as { name?: unknown } | null)?.name;
  return { name: typeof name === "string" && name.trim() !== "" ? name : null, website: null };
}

function parseLever(page: string): VendorIdentity {
  const title = /<title>([^<]*)<\/title>/i.exec(page)?.[1];
  const name = title === undefined ? "" : decodeEntities(title).trim();
  return { name: name === "" ? null : name, website: null };
}

function parseAshby(page: string): VendorIdentity {
  const start = page.indexOf('"organization":{');
  if (start === -1) return { name: null, website: null };
  // The org object opens with organizationId, then name, then publicWebsite —
  // a bounded window is enough and avoids brace-matching the nested arrays.
  const window = page.slice(start, start + 2000);

  const rawName = /"name":"((?:[^"\\]|\\.)*)"/.exec(window)?.[1];
  const rawSite = /"publicWebsite":(?:null|"((?:[^"\\]|\\.)*)")/.exec(window)?.[1];

  const unquote = (v: string) => JSON.parse(`"${v}"`) as string;
  const name = rawName === undefined ? null : unquote(rawName).trim() || null;
  const website = rawSite === undefined ? null : hostOf(unquote(rawSite));
  return { name, website };
}

// Per-host semaphore. Mirrors createHostLimiter in ./validate.ts (task 2.4) —
// that one is module-private there and this module must not edit it, so the
// pattern is duplicated rather than imported. `FetchLike` IS imported from it.
function createHostLimiter(maxConcurrent: number) {
  const active = new Map<string, number>();
  const waiters = new Map<string, Array<() => void>>();

  function acquire(host: string): Promise<void> {
    const inFlight = active.get(host) ?? 0;
    if (inFlight < maxConcurrent) {
      active.set(host, inFlight + 1);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const queue = waiters.get(host) ?? [];
      queue.push(resolve);
      waiters.set(host, queue);
    });
  }

  function release(host: string): void {
    const queue = waiters.get(host) ?? [];
    const next = queue.shift();
    if (next) {
      next();
      return;
    }
    active.set(host, Math.max(0, (active.get(host) ?? 1) - 1));
  }

  return async function run<T>(host: string, fn: () => Promise<T>): Promise<T> {
    await acquire(host);
    try {
      return await fn();
    } finally {
      release(host);
    }
  };
}

const limiter = createHostLimiter(MAX_CONCURRENT_PER_HOST);

async function fetchIdentity(
  candidate: IdentityCandidate,
  url: string,
  fetchFn: FetchLike,
): Promise<VendorIdentity | { unverifiable: string }> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { "user-agent": USER_AGENT } });
  } catch (err) {
    return { unverifiable: `network_error: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (res.status !== 200) {
    // Design §7: a 403/429 is a stop signal for the vendor, never a retry.
    // The caller batching these is responsible for halting that vendor; here
    // we report it honestly and make exactly one request.
    return { unverifiable: STATUS_REASONS[res.status] ?? `http_${res.status}` };
  }

  if (candidate.ats === "greenhouse") return parseGreenhouse(await res.json());
  const page = await res.text();
  return candidate.ats === "lever" ? parseLever(page) : parseAshby(page);
}

export async function verifyIdentity(
  candidate: IdentityCandidate,
  opts: VerifyIdentityOptions,
): Promise<IdentityVerdict> {
  const { fetch: fetchFn, politenessDelayMs = DEFAULT_POLITENESS_DELAY_MS } = opts;
  const { url, host } = endpointFor(candidate); // throws on unknown ats, before any I/O

  const identity = await limiter(host, async () => {
    try {
      return await fetchIdentity(candidate, url, fetchFn);
    } finally {
      if (politenessDelayMs > 0) {
        await new Promise((r) => setTimeout(r, politenessDelayMs));
      }
    }
  });

  if ("unverifiable" in identity) {
    return { status: "unverifiable", reason: identity.unverifiable };
  }

  // Domain evidence outranks name evidence where the vendor gives it (ashby
  // only): a shared registrable domain is far harder to collide on than a
  // name. A DIFFERENT domain is not treated as proof of mismatch, though —
  // one company legitimately runs several domains — so it falls through to the
  // name comparison rather than hard-failing.
  if (identity.website !== null) {
    const expected = hostOf(`https://${candidate.companyDomain}`);
    if (expected !== null && identity.website === expected) {
      return {
        status: "confirmed",
        evidence: `${candidate.ats}/${candidate.slug} publicWebsite ${identity.website} matches companyDomain ${candidate.companyDomain}`,
      };
    }
  }

  if (identity.name === null) {
    return { status: "unverifiable", reason: "no_identity_field" };
  }

  const vendorNorm = normalizeCompanyName(identity.name);
  const expectedNorm = normalizeCompanyName(candidate.name);

  if (vendorNorm === "" || expectedNorm === "") {
    return { status: "unverifiable", reason: "no_identity_field" };
  }

  // matchMethod is deliberately NOT used to weight the verdict. It describes
  // how the candidate was GENERATED (our prior); the verdict rests on what the
  // vendor SAID (direct evidence). Letting a "domain-stem" prior override a
  // name mismatch would re-admit exactly the errors this module exists to
  // catch — "porter" is a domain-stem-shaped match too. It is carried on the
  // evidence string so the operator can slice the report by it.
  if (vendorNorm === expectedNorm) {
    return {
      status: "confirmed",
      evidence: `${candidate.ats}/${candidate.slug} reports "${identity.name}", matching expected "${candidate.name}" (via ${candidate.matchMethod})`,
    };
  }

  return {
    status: "mismatch",
    evidence: `${candidate.ats}/${candidate.slug} reports "${identity.name}", but we expected "${candidate.name}" (${candidate.companyDomain}, via ${candidate.matchMethod})`,
  };
}
