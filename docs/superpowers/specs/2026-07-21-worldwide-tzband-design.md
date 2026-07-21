# Worldwide timezone band — design

**Date:** 2026-07-21 · **Status:** approved by operator · **Scope:** postings pool band model + crawl-time classifier

## Context

Prod measurement (2026-07-21, 18,517 live postings): americas 49.3%, unassigned 24.5% (4,535), emea 14.9%, apac 11.3%. Every unassigned posting has a non-empty location string — the bucket is classifier misses plus genuinely location-agnostic postings ("Remote - Anywhere", "Global"). Goal: postings the employer explicitly opens to any location must count toward every band's user-facing supply, moving APAC-facing supply toward the 33% target without mislabeling data.

Three approaches were considered: (A) location-string-only worldwide tokens; (B) A plus deterministic JD-phrase heuristics at crawl; (C) LLM classification of the inconclusive tail. **B approved.** C deferred (breaks the zero-LLM crawl invariant, nightly token cost); A alone leaves the bare-"Remote" bucket untouched.

## 1. Band model

`TzBand` (`src/types/index.ts`) becomes `"apac" | "emea" | "americas" | "worldwide"`.

- `worldwide` = the employer explicitly stated location-agnostic hiring.
- `null` (unassigned) keeps meaning "we don't know" — bare "Remote" with no other signal stays null.
- Semantics of the three regional bands are unchanged: "where the work sits, timezone-wise" — a relevance proxy, not a hire-from-eligibility claim.

The Drizzle `enum:` on `postings.tzBand` / `jobs.tzBand` (`src/server/persistence/schema.ts:424`, `:190`) is type-level only on SQLite text columns — expected to need no DB migration (verify at plan time).

## 2. Classifier (`src/server/score/tzBand.ts`)

`resolveTzBand` gains a third input: `{ statedTz, location, description }`, precedence in that order.

**Location pass:** new worldwide tokens — `anywhere`, `worldwide`, `global`, `globally` (word-anchored, same style as existing SAFE_TOKENS). Rule: a specific band token in the same string beats a worldwide token ("Global Anywhere - Eastern or European Time Zones" → not worldwide). Implementation: probe regional tokens first; worldwide only if no regional token matched.

**Description probe:** runs only when statedTz and location are both inconclusive. Two curated high-precision phrase lists over the already-stored JD text (`postings.description`, capped 40k by connectors):

- worldwide-positive: "work from anywhere", "anywhere in the world", "fully remote, anywhere", "location doesn't matter" — extend conservatively.
- region-restrictive: "must be based in the US" / "eligible to work in the United States" → americas; "based in Europe" → emea; "APAC hours" / "APAC time zone" → apac — extend conservatively.

Conflicting hits (worldwide-positive AND region-restrictive, or two different regions) → null. No hits → null. Same conservative philosophy as the existing SAFE/STATED_ONLY/AMBIGUOUS design. Zero LLM.

## 3. Crawl integration

`src/server/sources/crawler.ts` (~line 239) passes `p.description` into the resolver. tzBand is already re-stamped on every re-crawl upsert (crawler.ts:278), so the full live pool re-bands on the first nightly crawl after deploy — no backfill, no migration job.

Known limitation: the SmartRecruiters connector's list API carries no JD text, so its postings never enter the description probe (their locations are concrete cities; the location pass covers them).

## 4. Contract + admin UI

- `AdminPoolStats.tzBands` (`src/types/index.ts:618-624`) gains a `worldwide` row; poolStats repo (`src/server/persistence/repos/poolStats.ts`) counts it; strip order: Americas, EMEA, APAC, Worldwide, Unassigned.
- `PoolStrips.tsx` label map gains `worldwide: "Worldwide"`.
- OpenAPI regenerated (`npm run check` contract step).
- No new KPI widget — the Pool strip is the measure.

## 5. User-facing supply

One shared helper (in `tzBand.ts`, beside `isBandAligned`): worldwide matches every band at equal weight. Every site that favors/filters `tzBand === "apac"` (the DECISION-A soft-rank path: `isBandAligned`/`misalignedCount` and the pinned SQL CASE in `repos/jobs.ts`) treats `worldwide` as aligned with any allowed-band set. The SQL↔TS parity test extends over the new value.

## 6. Testing + rollout

- TDD; fixtures include the real prod miss-strings ("Remote - Anywhere", "Global Anywhere - Eastern or European Time Zones", bare "Remote" → still null) and description-probe cases incl. conflicts.
- The `feat/apac-sources` regression tests asserting "Anywhere"/"Global" → null are deliberately superseded here.
- Post-deploy verification: admin Pool strip after one nightly crawl; expect unassigned to shrink and a nonzero Worldwide segment.

## Out of scope (deferred)

LLM classification of the remaining unassigned tail; relocation/visa/hire-from eligibility JD parsing (own spec); growth-cron APAC bias; gh:stripe/gh-stripe source dedupe (tracked separately).
