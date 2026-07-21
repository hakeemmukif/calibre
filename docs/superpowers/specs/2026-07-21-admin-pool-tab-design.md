# Admin Pool tab — static v1 (design)

Date: 2026-07-21. Status: **operator-approved, locked**. Born from a 4-option mockup
round; operator picked a C+D merge ("number heroes" + "distribution strips"). A
subsequent `/plan` pass turns §7 into tasks.

---

## 0. Purpose

An admin-only stats view over the global `postings` pool (18.5k live rows, 816 boards
— see `2026-07-17-global-postings-pool-architecture.md`) answering "what is in the
pool" — composition by job function, timezone band, freshness, and company
concentration.

---

## 1. Operator-locked decisions (do not re-litigate)

1. **Static v1.** NO history table, NO sparkline data, NO cross-filter endpoints. The
   sparkline slot on function cards and the filter-chip row are visually reserved but
   inert/absent in v1 — both are additive later without rework.
2. **Hybrid function source.** Per posting, use `function_tag` when present (canonical,
   LLM P.4 classifier — fills lazily at scan time; only ~70/18,518 tagged as of
   2026-07-21), else fall back to a deterministic title-keyword bucket helper (§4). The
   tab surfaces tag-coverage % as an honesty meter.
3. **Design system.** Composes caliber-ui canon only (`tokens.css` Swiss Grid;
   SummaryStrip/Card/Tag/Chip/Tabs primitives, FitBar geometry for the strips). Red
   accent used once (largest function's numeral in `--accent-ink`).

---

## 2. Route & access

`/admin/pool`, in the admin tab row (Users · Crawl · Pool — `/admin/crawl` is the
existing precedent). Gated `requireAdmin()` server-side; admin sidebar/nav shows it
only for `role === 'admin'` (same defense-in-depth pattern as `/admin` —
`component-inventory.md` §1a: API enforcement is independent of nav visibility).

---

## 3. UI composition (top→bottom)

- **Tile row** (SummaryStrip idiom, `--surface-sunken`, tabular numerals): Live
  postings · Delisted · New last 24h · Boards (enabled/total) · Function-tag coverage
  %.
- **`PoolFunctionCards`** — grid of 12 stat cards, one per function bucket (§4):
  eyebrow label, `--type-h1` tabular count, caption "N% of pool". Largest bucket:
  numeral in `--accent-ink` + `--border-strong` top rule. Sparkline slot
  reserved-empty (§1.1).
- **`PoolStrips`** — three full-width 100% stacked strips (FitBar geometry, Chip
  legends):
  (a) **TZ band** — americas / emea / apac + unassigned in `--neutral-300`;
  (b) **Freshness** — `firstSeen` buckets 24h / 2–7d / 8–30d / older;
  (c) **Company concentration** — top-10 companies vs rest, largest company segment
  called out by name.
  Segments ≥4% labeled inline; smaller segments collect into "other".
  **Shipped deviation:** segments carry title-tooltips + a Chip legend row instead of
  literal inline text labels; the ≥4% rule governs inline labels only, where rendered
  — the concentration strip's Chip legend lists all top-10 companies uncollapsed
  regardless of share (its top-10 selection already is the collapse).
- **States** (Storybook minimum): loading / empty (pool empty) / error+retry /
  populated.

---

## 4. Contract (Zod-first in `src/types`, OpenAPI rides along, fail-loud)

New `AdminPoolStats` schema:

```
AdminPoolStats {
  totals: {
    live: number
    delisted: number
    newLast24h: number
    sourcesEnabled: number
    sourcesTotal: number
    tagCoveragePct: number
  }
  functionMix: [{
    bucket: string
    count: number
    share: number
    source: 'tag' | 'keyword'   // majority provenance for that bucket
  }]
  tzBands: [{
    band: 'americas' | 'emea' | 'apac' | 'unassigned'
    count: number
    share: number
  }]
  freshness: [{
    bucket: '24h' | '2-7d' | '8-30d' | 'older'
    count: number
  }]
  concentration: {
    topCompanies: [{ company: string, count: number }]   // 10 entries
    top10Count: number
    restCount: number
  }
}
```

Missing required fields throw at the boundary — no fallback defaults (project rule,
CLAUDE.md).

---

## 5. Server

`GET /api/admin/pool` (read-only) → one repo function in `server/*` doing GROUP-BY
aggregates over `postings WHERE delisted_at IS NULL` (plus the delisted count).
Milliseconds on 18.5k rows; ZERO LLM calls at request time. Layering UI → `features/*`
→ `server/*` preserved.

---

## 6. Keyword bucket helper

Deterministic, shared, pinned by unit tests; lower-cased title, **first-match-wins** in
this order (verbatim — these exact buckets produced the operator-reviewed numbers in
§8):

1. **engineering** — `engineer|developer|devops|sre|architect`
2. **data** — `data|analytics|machine learning|"ml "|" ai"|scientist`
3. **product** — `product manager|product owner|program manager|project manager`
4. **design** — `design|ux|"ui "`
5. **sales** — `sales|account executive|account manager|business development`
6. **marketing** — `marketing|growth|content|seo|brand`
7. **cs_support** — `customer success|support|customer experience`
8. **people_hr** — `recruit|people|talent|"hr "`
9. **finance_legal** — `finance|accounting|legal|counsel|compliance`
10. **ops_admin** — `operations|office|executive assistant|chief of staff`
11. **leadership** — `head of|director|"vp "|vice president|chief`
12. **other** — no match

Implement in TS (single shared helper used by the repo aggregate), not duplicated SQL
— one source of truth. The hybrid rule (§1.2) is applied per-row before aggregation.

**Pinned collision case:** a title like "Head of Engineering" matches bucket 1
(`engineering`, via `engineer`) before it ever reaches bucket 11 (`leadership`, via
`head of`) — first-match-wins by bucket order, not by substring position. This is an
explicit pinned test case, not an edge case to "fix": the order above is the operator-
reviewed classification and must not be reordered without re-running §8's calibration.

**Tag→bucket mapping (amended during build — Task 3 review):** the hybrid rule (§1.2)
reads "`function_tag` when present" as `postings.functionTag`, a value from P.4's
classifier vocabulary (`FUNCTION_TAGS`, `src/server/sources/function.ts`) — which is
**not** the same 12-id set as the buckets above. 6 of its 12 values diverge in spelling:
`customer-success`, `people`, `finance`, `legal`, `operations`, `executive` don't
literally match a bucket id (`finance` and `legal` both fold into the single
`finance_legal` bucket; there is no dedicated `legal` bucket). Using a raw tag string as
the bucket key would silently drop those tagged rows out of `functionMix`, breaking the
invariant `sum(functionMix[].count) === totals.live`. Fix: an explicit, exhaustive
`TAG_TO_BUCKET: Record<FunctionTag, FunctionBucket>` map
(`src/server/pool/functionBucket.ts`) resolves every non-empty `functionTag`:

| P.4 tag | bucket |
|---|---|
| engineering | engineering |
| product | product |
| design | design |
| data | data |
| sales | sales |
| marketing | marketing |
| customer-success | cs_support |
| people | people_hr |
| finance | finance_legal |
| legal | finance_legal |
| operations | ops_admin |
| executive | leadership |

An unknown non-empty `functionTag` value (one outside `FUNCTION_TAGS`, e.g. hand-edited
data) **throws** in the repo aggregate — fail-loud, never silently re-bucketed or
dropped. An empty-string `functionTag` is treated as absent (same as `null`) and falls
back to the keyword bucket on title, per the same non-empty check used for provenance.

---

## 7. Testing

- Unit tests pinning the bucket helper — representative titles per bucket, plus the
  first-match-wins collision case (§6).
- Repo aggregate test on seeded in-memory SQLite.
- Contract parse test for `AdminPoolStats`.
- API 403 test for non-admin.
- Storybook stories under `Compositions/Admin/` for the 4 states (§3).

---

## 8. Reference snapshot (2026-07-21 prod, calibration only — not fixture data)

Function mix: engineering 6,347 (34.3%) · other 3,785 (20.4%) · sales 2,727 (14.7%) ·
marketing 897 · product 806 · data 806 · ops_admin 679 · cs_support 582 ·
finance_legal 548 · design 492 · leadership 433 · people_hr 416.

TZ bands: americas 9,113 · unassigned 4,563 · emea 2,754 · apac 2,088.

Concentration: top company Stripe 1,026; top-20 companies ≈ 38% of pool.

---

## 9. Out of scope (v1)

Daily composition snapshots + migration, sparkline series, cross-filter re-query
endpoints, any user-facing (non-admin) market view, batch LLM classification of the
pool.

---

## 10. Follow-ups enabled (explicitly later)

History table + sparklines; cross-filter chips; possible user-facing "market overview"
reusing `PoolStrips`.
