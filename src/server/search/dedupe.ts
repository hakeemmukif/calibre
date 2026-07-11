// URL normalization + cross-source collision policy (system-architecture.md
// §3 "Merge/dedupe" + §4 "Dual-source dedupe"). Pure functions — run.ts wires
// these into jobsRepo.upsertByDedupeKey; no DB access here.
import { roleTokens } from "./roleMatch";

// utm_* is a prefix rule; the rest are exact known tracking params.
const TRACKING_PARAM_NAMES = new Set(["gclid", "fbclid", "msclkid", "mc_cid", "mc_eid", "ref", "ref_src", "igshid"]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_PARAM_NAMES.has(lower);
}

/**
 * Normalizes a posting URL into a stable dedupe key: lowercase host, tracking
 * params stripped, fragment dropped (URL.search never carries it), trailing
 * slash stripped (except a bare root path).
 */
export function dedupeKeyFor(url: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();

  const params = new URLSearchParams(parsed.search);
  for (const key of [...params.keys()]) {
    if (isTrackingParam(key)) params.delete(key);
  }
  params.sort();
  const search = params.toString();

  const pathname = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, "") : parsed.pathname;

  return `${host}${pathname}${search ? `?${search}` : ""}`;
}

/** Lowercase, alnum-hyphen slug — the crude "same company" key for secondaryKey. */
export function companySlugFor(company: string): string {
  return company
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Order-independent content-token fingerprint of a role title, for secondaryKey. */
export function roleTokensHash(title: string): string {
  return [...new Set(roleTokens(title))].sort().join("-");
}

/**
 * The cross-source secondary key (system-architecture.md §3): same company +
 * same role tokens + same location, regardless of which source/URL it was
 * found under. Two postings sharing this key are the same opening even when
 * their canonical URLs (and thus dedupeKey) differ.
 */
export function secondaryKey(input: { companySlug: string; roleTokensHash: string; location: string }): string {
  return `${input.companySlug.toLowerCase()}::${input.roleTokensHash}::${input.location.toLowerCase().trim()}`;
}

export interface CanonicalCandidate {
  kind: "ats" | "board";
  sourceId: string;
  url: string;
}

/**
 * ATS beats board for the canonical `jobs.url`/dedupeKey; the loser's URL
 * becomes an alias. When neither/both are the same kind, `a` (arbitrarily
 * but deterministically — first-seen in the caller's iteration order) wins.
 */
export function resolveCanonicalCollision(
  a: CanonicalCandidate,
  b: CanonicalCandidate,
): { canonical: CanonicalCandidate; alias: CanonicalCandidate } {
  if (a.kind === "ats" && b.kind !== "ats") return { canonical: a, alias: b };
  if (b.kind === "ats" && a.kind !== "ats") return { canonical: b, alias: a };
  return { canonical: a, alias: b };
}
