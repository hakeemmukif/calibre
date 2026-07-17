// Global postings-pool dedupe — architecture spec 2026-07-17 §4 "Decision 4 —
// Dedup & canonicalization". Pure functions only: alias-merge writes belong
// to P.3's crawler, not here. Reuses the shipped per-run primitives
// (`companySlugFor`/`roleTokensHash`/`secondaryKey`/`dedupeKeyFor`,
// `src/server/search/dedupe.ts`) and lifts them to crawl time; the
// ATS/board/aggregator three-tier ordering below is new (arch §4: "extend
// the same ordering to ATS > board > aggregator when Himalayas-class sources
// arrive" — aggregator has no live connector yet, but the tier is provisioned
// now so the resolver doesn't need a second migration later).
import { companySlugFor, dedupeKeyFor, roleTokensHash, secondaryKey } from "../search/dedupe";

/**
 * Primary row identity (the `postings.canonicalKey` UNIQUE) — arch §4: an
 * `externalId`-bearing connector (all four current connectors supply one)
 * anchors on `ats:{sourceId}:{externalId}`; otherwise the normalized-URL key.
 * Same input always produces the same key (re-crawl stability).
 */
export function canonicalKey(posting: { sourceId: string; externalId?: string; url: string }): string {
  return posting.externalId
    ? `ats:${posting.sourceId}:${posting.externalId}`
    : `url:${dedupeKeyFor(posting.url)}`;
}

/**
 * Location bucket v1 (arch §4, "Location bucket v1"): remote-keyword wins
 * first, else the city-level segment before the first comma, else the
 * honest-absence empty bucket. Deliberately biased to under-merge — a weak
 * bucket costs an extra pool row (cosmetic, self-describing via aliases),
 * never a lost distinct posting.
 */
export function locationBucket(location: string | undefined): string {
  // Absent location is a genuine "unknown", not a fabricated value — arch
  // §4 point 4 pins "" as the bucket, not a guessed default.
  const normalized = (location ?? "").toLowerCase().trim().replace(/\s+/g, " ");
  if (normalized === "") return "";
  if (/remote|anywhere|work from home|distributed/.test(normalized)) return "remote";
  const city = normalized.split(",")[0];
  return city.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Secondary cross-board key (arch §4): same company + same role tokens +
 * same location bucket, regardless of which board/URL it was found under —
 * the shipped `secondaryKey` lifted to crawl time via the v1 location bucket.
 */
export function crossBoardKey(posting: { company: string; title: string; location?: string }): string {
  return secondaryKey({
    companySlug: companySlugFor(posting.company),
    roleTokensHash: roleTokensHash(posting.title),
    location: locationBucket(posting.location),
  });
}

export type SourceTier = "ats" | "board" | "aggregator";

export interface GlobalCanonicalCandidate {
  tier: SourceTier;
  sourceId: string;
  canonicalKey: string;
}

const TIER_RANK: Record<SourceTier, number> = { ats: 0, board: 1, aggregator: 2 };

/**
 * Cross-board collision resolution (arch §4): ATS-direct > board >
 * aggregator. The loser becomes an alias of the winner (`postings.aliases`,
 * the shipped `mergeAliases` union semantics — written by P.3, not here).
 * Ties fall back to the first argument, deterministically (mirrors the
 * shipped `resolveCanonicalCollision`).
 */
export function resolveCanonicalCollision(
  a: GlobalCanonicalCandidate,
  b: GlobalCanonicalCandidate,
): { canonical: GlobalCanonicalCandidate; alias: GlobalCanonicalCandidate } {
  if (TIER_RANK[a.tier] < TIER_RANK[b.tier]) return { canonical: a, alias: b };
  if (TIER_RANK[b.tier] < TIER_RANK[a.tier]) return { canonical: b, alias: a };
  return { canonical: a, alias: b };
}
