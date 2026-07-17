# Connector Live Verification — Tier-2 ATS Vendors

Date: 2026-07-17. Scope: design §4.2 Tier 2 / plan tasks 4.1a–4.6a (live verification as
build prerequisite, design §5). All claims below are grounded in HTTP responses received
2026-07-17 (03:30–03:45 UTC) with UA `Mozilla/5.0 (compatible; caliber-verify/1.0)`, no
auth, no header spoofing, ≤2 concurrent per vendor host with delays. **No 403 or 429 was
received from any vendor.** No rate-limit headers (`X-RateLimit-*`, `Retry-After`) were
observed on any response.

Fixtures (real captured responses, trimmed to 2–3 postings, field names verbatim):
`src/server/search/connectors/__fixtures__/live-verify/{workable.json, recruitee.json,
personio.xml, pinpoint.json, rippling.json, rippling-detail.json, smartrecruiters-robots.txt}`
(in the `remote-source-matching-fix` worktree).

## Verdict table

| Vendor | Verdict | Slugs verified live | Endpoint | Pagination | Remote signal | fetchDetail needed | Slug supply (jobhive, MIT) |
|---|---|---|---|---|---|---|---|
| Workable | **VERIFIED** | apna (110), pavago (1,572), nuvei (57), logifuture (6) | `GET apply.workable.com/api/v1/widget/accounts/{slug}` (+`?details=true`) | none — full list in one call | `telecommuting: true/false` | No (use `?details=true`) | **4,269** |
| Recruitee | **VERIFIED** (per-tenant robots gate required) | blueforest (2), snappet (3), sendcloud (1, zombie), tellent (0) | `GET {slug}.recruitee.com/api/offers/` | none documented; UNKNOWN for large boards | `remote`/`hybrid`/`on_site` booleans | No (description in list) | **888** |
| Personio | **VERIFIED** | 1nce (15), wik (4) | `GET {slug}.jobs.personio.com/xml?language=en` (XML) | none observed | office string (e.g. "Remote China") — no boolean | No (full JD in feed) | **2,463** |
| Pinpoint | **VERIFIED** (no postedAt; possible 1,000 cap) | workwithus (3), trilongroup (1,000), livelink (8) | `GET {slug}.pinpointhq.com/postings.json` | none documented; trilongroup = exactly 1,000 rows (cap UNKNOWN) | `workplace_type: remote\|hybrid\|onsite` | No (description in list) | **350** |
| Rippling | **VERIFIED** (paginated + N+1) | joinroot (12), rippling (780/39 pages), novata (7) | `GET ats.rippling.com/api/v2/board/{slug}/jobs` (+`?page=N`), detail `…/jobs/{id}` | **yes** — `page`/`pageSize:20`/`totalItems`/`totalPages`; `?page=1` verified distinct | `locations[].workplaceType: "REMOTE"` | **Yes** — description, `createdOn`, `companyName` only in detail | **1,923** |
| SmartRecruiters | **BLOCKED-LEGAL** | — (API never called) | — | — | — | — | 2,214 (moot) |

## Workable — VERIFIED

- **Slugs**: `apna`, `pavago`, `nuvei` (from the design's gap-fill research; all HTTP 200),
  `logifuture` (mid-file pick from jobhive `workable.csv`, 200). Note: `workable` itself is
  **not** a valid slug (404) — Workable's own board is at a different slug.
- **Endpoint + status**: `GET https://apply.workable.com/api/v1/widget/accounts/{slug}` →
  200, `application/json`, no auth, `access-control-allow-origin: *`. `?details=true` →
  200, adds a `description` field per job (verified: 5,020-char HTML on nuvei's first job).
- **Response shape**: `{ name, description, jobs: [...] }`. Job fields (verbatim, from
  apna/nuvei): `title, shortcode, code, employment_type, telecommuting, department, url,
  shortlink, application_url, published_on, created_at, country, city, state, education,
  experience, function, industry, locations[{country, countryCode, city, region, hidden}]`
  (+ `description` with `details=true`).
- **Pagination**: none. `pavago` returned **1,572 jobs in one 930 KB response** — the
  design's "full list in one call" claim holds even at 1.5k jobs. Size caveat: with
  `details=true`, nuvei's 57 jobs = 343 KB; a 1,500-job board with descriptions will be
  multi-MB in a single response.
- **RawPosting mapping**: `title`→title; `url`→url (`application_url` is the direct apply
  link); company→top-level `name` (or source row); `location`→`city`/`country` (+
  `locations[]`); `postedAt`→`published_on` (date-only, e.g. `"2026-06-27"`; `created_at`
  also present); `externalId`→`shortcode` (e.g. `01B0CB39DD`, stable, used in the URL);
  description→`details=true`.
- **Gap — the `function` field is real but unreliable**: nuvei's values across 57 jobs were
  `['', 'Business Analyst', 'Data Analyst', 'Engineering', 'Financial Analyst', 'Legal',
  None, 'Product Management']` — the first job ("Accountant") had `function: null`; pavago's
  1,572 jobs carried only `''` and `'Legal'`. Do **not** lean on it; the design's own
  function-tagging pipeline (plan 3.3/3.6) remains necessary.
- **Remote signal**: `telecommuting` boolean — verified `true` on 3 apna jobs (e.g.
  "Customer Support Manager (Work from Home)") and 12/57 nuvei jobs.
- **Rate limits**: none observed; `x-cached-response: HIT` seen (CDN-cached responses),
  Cloudflare-fronted.
- **Legal**: `apply.workable.com/robots.txt` (200, verbatim):
  `User-agent: *` / `Content-Signal: search=yes, ai-input=yes, ai-train=no` / `Disallow:`
  (empty → fully open). Vendor-documented widget endpoint (design §4.2). The
  `ai-train=no` content signal is about model training, which this crawler does not do;
  `search=yes, ai-input=yes` cover indexing/aggregation use.
- **Slug supply**: jobhive (`kalil0321/ats-scrapers`) `ats-companies/workable.csv` —
  **4,269 rows** (matches the design's claim exactly), schema `name,slug,url`, licence
  **MIT** (LICENSE file fetched, "MIT License, Copyright (c) 2026 Kalil Bouzigues").
- **Build-readiness: READY. Confidence: high.** Everything task 4.1a asks for is confirmed;
  the only design correction is the unreliable `function` field.

## Recruitee — VERIFIED (with a per-tenant robots gate)

- **Slugs**: `blueforest` (found via live job page, 2 offers, genuinely live), `snappet`
  (jobhive mid-file pick, 200, 3 offers), `sendcloud` (200 but a "Senior Marketer (Sample)"
  demo offer — its robots redirects to `recruitee.com/careers_not_hosted`, i.e. a zombie
  board), `tellent` (200, `{"offers":[]}`). `framer`, `piktochart`, `usercentrics` → 404.
- **Endpoint + status**: `GET https://{slug}.recruitee.com/api/offers/` → 200,
  `application/json`, no auth. Officially documented (Careers Site API,
  `docs.recruitee.com/reference/offers`; documented filters: `department`, `tag`).
- **Response shape**: `{ offers: [...] }`. Offer fields (verbatim, from sendcloud/blueforest —
  56 keys): `id, title, slug, status, remote, hybrid, on_site, city, country, country_code,
  location, postal_code, created_at, published_at, updated_at, close_at, careers_url,
  careers_apply_url, company_name, department, tags, salary{min,max,period,currency},
  employment_type_code, description, requirements, open_questions, translations, guid, …`.
- **RawPosting mapping**: `externalId`→`id`; `url`→`careers_url`; `title`; company→
  `company_name`; `location`→`location`/`city`+`country`; `postedAt`→`published_at`
  (full timestamp, e.g. `"2026-07-02 17:18:08 UTC"` — note non-ISO format, needs parsing);
  description→`description` (in the list response, 4,498 chars verified).
- **Remote signal**: explicit `remote`/`hybrid`/`on_site` booleans (blueforest:
  `remote: true`, `location: "Remote job"`).
- **fetchDetail**: not needed.
- **Pagination**: none documented and none observed (all sampled boards small). Behaviour on
  a 500-offer board is **UNKNOWN**.
- **Legal — the finding of this verification**: robots.txt is **per-tenant**, not global:
  `blueforest.recruitee.com/robots.txt` → `Disallow: /v/` only (API path open);
  `snappet.recruitee.com/robots.txt` → **`Disallow: /`** (everything). The connector/crawler
  must check robots per board and skip fully-disallowed tenants — the same legal line that
  gates SmartRecruiters, applied per slug. (snappet was fetched once before this was
  discovered; no further requests were made to it.)
- **Rate limits**: none observed (`server: Cowboy`, via google front).
- **Slug supply**: jobhive `recruitee.csv` — **888 rows**, MIT (the design marked this
  UNKNOWN; it exists). Expect zombie boards (sendcloud-style) — validation must require
  non-empty `offers` and a non-redirecting robots/site.
- **Build-readiness: READY**, with two build requirements: per-board robots gate, and
  zombie-board filtering in validation. **Confidence: high** on mechanics, medium on
  effective slug yield.

## Personio — VERIFIED

- **Slugs**: `1nce` (design's verified example — 200, 15 positions, 113 KB), `wik`
  (jobhive mid-file pick — 200, 4 positions). `enpal` (my guess, not from the CSV) → 307
  redirect to `personio.com`, i.e. dead slugs redirect rather than 404.
- **Endpoint + status**: `GET https://{slug}.jobs.personio.com/xml?language=en` → 200,
  `text/xml`, no auth, `access-control-allow-origin: *`.
- **Response shape** (verbatim elements): root `<workzag-jobs>`, repeated `<position>` with
  `id, subcompany, office, additionalOffices/office, department, recruitingCategory, name,
  jobDescriptions/jobDescription{name, value(CDATA HTML)}, employmentType, seniority,
  schedule, yearsOfExperience, keywords, occupation, occupationCategory, createdAt`.
  `createdAt` is full ISO 8601 (`2026-04-14T11:55:13+00:00`).
- **RawPosting mapping**: `title`→`name`; `externalId`→`id`; `postedAt`→`createdAt`;
  company→`subcompany` when present, else source row; `location`→`office` (+
  `additionalOffices`); description→concatenated `jobDescription` sections (HTML in CDATA).
- **URL — the XML has no URL element.** Verified live: the pattern
  `https://{slug}.jobs.personio.com/job/{id}` returns 200 on both boards
  (`1nce.jobs.personio.com/job/2600654`, wik's first id). This constructed-URL rule is
  verified, not inferred.
- **Remote signal**: office string only, as the design says — `<office>Remote China</office>`,
  `<additionalOffices><office>Home Office China</office>` observed. No boolean. A
  substring convention (`remote`/`home office`, case-insensitive) is the honest heuristic;
  postings without it fall to `parseLocationGeo` as with any location string.
- **Also present**: `occupationCategory` (e.g. `sales_and_business_development`) — a free
  bonus signal for function tagging.
- **Pagination**: none observed (single XML document). Behaviour on very large boards
  UNKNOWN.
- **Legal**: robots.txt on `{slug}.jobs.personio.com` → 404 (no restrictions declared);
  vendor-documented XML syndication feature (design §4.2). CloudFront-served, ETag present
  (conditional GETs possible — nice for the crawler).
- **Rate limits**: none observed.
- **Slug supply**: jobhive `personio.csv` — **2,463 rows**, MIT (design marked UNKNOWN;
  it exists).
- **Build-readiness: READY** — needs the XML parser decision from task 4.3a (payload is
  simple, flat, CDATA-heavy; `fast-xml-parser` or a small hand parser both plausible — that
  decision remains the operator's). **Confidence: high.**

## Pinpoint — VERIFIED (one hard gap: no posted date)

- **Slugs**: `workwithus` (Pinpoint's own board, 3 postings), `trilongroup` (7.1 MB,
  exactly 1,000 postings), `livelink` (jobhive mid-file pick, 8 postings).
- **Endpoint + status**: `GET https://{slug}.pinpointhq.com/postings.json` → 200,
  `application/json`, no auth. Officially documented
  (`developers.pinpointhq.com/docs/jobs-json-endpoint`: "no authentication", "can be
  fetched client side with no CORS issues"; filters `department_id, location_id,
  division_id, structure_custom_group_one_id, location_city_state_name`).
- **Response shape**: `{ data: [...] }`. Posting fields (verbatim): `id, title, url, path,
  description, benefits(_header), key_responsibilities(_header),
  skills_knowledge_expertise(_header), compensation, compensation_minimum/maximum/
  currency/frequency/visible, employment_type, employment_type_text, workplace_type,
  workplace_type_text, deadline_at, reporting_to, job{id, requisition_id, department{id,name},
  division, structure_custom_group_one}, location{id, city, name, postal_code, province,
  street_address}`.
- **RawPosting mapping**: `externalId`→`id`; `url`→`url` (absolute); `title`;
  `location`→`location.name`/`city`; `salaryRaw`→`compensation`; description→`description`
  (+ the three section fields) — in the list, no detail call.
- **Gap — `postedAt` does not exist.** Verified in payloads and confirmed by the vendor
  docs ("The API lacks a posted or created date field. Only `deadline_at`"). Fallback is
  the pool's own `firstSeenAt` (crawl-time sighting) — reported as a gap, not papered over.
- **Gap — no company-name field** in the posting; company comes from the source row (the
  board is company-scoped).
- **Remote signal**: `workplace_type` — observed values across trilongroup's 1,000 rows:
  `onsite: 560, hybrid: 410, remote: 30` — plus `workplace_type_text` ("Fully remote").
- **Pagination**: none documented; **trilongroup returned exactly 1,000 rows**, which
  smells like a silent cap — UNKNOWN whether it truncates. For startup-sized boards this is
  irrelevant; flag it in the connector comment.
- **Legal**: cleanest surveyed, as the design claims — customer-board robots
  (`livelink.pinpointhq.com/robots.txt`) disallows only `/mydata`, `/admin`, `/companies`;
  `postings.json` untouched; endpoint is explicitly built for third-party consumption.
- **Rate limits**: none observed.
- **Slug supply**: jobhive `pinpoint.csv` — **350 rows**, MIT — the smallest of the five;
  reach is limited regardless of connector quality. Function breadth: trilongroup's 1,000
  postings are an infrastructure-consulting group (broad but not startup-typical);
  workwithus shows product/eng/revenue. Startup-function breadth remains thin-sample, as
  the design said.
- **Build-readiness: READY. Confidence: high** on mechanics; reach is the limiter.

## Rippling — VERIFIED (paginated list + N+1 detail, undocumented surface)

- **Slugs**: `joinroot` (design's example — 12 jobs), `rippling` (Rippling's own board —
  **780 jobs, 39 pages**), `novata` (jobhive mid-file pick — 7 jobs).
- **List endpoint**: `GET https://ats.rippling.com/api/v2/board/{slug}/jobs` → 200, no
  auth. **Paginated — the design's "full list" framing needs this correction**: envelope is
  `{ items, page, pageSize, totalItems, totalPages }` with `pageSize: 20`;
  `?page=1` verified to return page 1 with distinct items (`page: 1` echoed, different
  first item). A 780-job board costs 39 list calls.
- **List item fields** (verbatim): `id` (uuid), `name`, `url`
  (`https://ats.rippling.com/{slug}/jobs/{id}`), `department{name}`,
  `locations[{name, country, countryCode, state, stateCode, city, workplaceType}]`,
  `language`. **No description, no date, no company name in the list.**
- **Detail endpoint** (the N+1): `GET …/board/{slug}/jobs/{id}` → 200. Fields (verbatim):
  `uuid, name, description` (an **object** keyed by section, e.g. `{"company": "<html…>"}`),
  `workLocations, department{name, base_department, department_tree},
  employmentType{label, id}, createdOn` (ISO with tz: `2026-07-14T10:45:51.914000-07:00`),
  `activeJobApplication` (application questions incl. knockouts — future `extractQuestions`
  material), `url, board{boardType, slug, logo}, payRangeDetails, companyName,
  unlistedFromSearch, jsonLd`.
- **RawPosting mapping**: list — `externalId`→`id`, `title`→`name`, `url`→`url`,
  `location`→`locations[0].name`; remote→`locations[].workplaceType === "REMOTE"`;
  `postedAt` → **missing from the list**, only detail `createdOn` (fallback: pool
  `firstSeenAt`, or accept it arrives when `fetchDetail` runs); company → from source row
  (list) or detail `companyName`; description → **detail only** → **`fetchDetail` is
  required**, exactly as the design/plan (4.5a) says — scoring-time only, never at crawl.
- **Legal/fragility**: `ats.rippling.com/robots.txt` → `Disallow: /internal/` only — the
  board API is not robots-blocked. But the surface is **undocumented** (header
  `x-middleware-rewrite: …/api/ats2_provisioning/…` confirms it's an internal service);
  it can change without notice — the plan's `consecutiveFailures` containment stands.
  Cloudflare-fronted (`__cf_bm` cookie set); no rate-limit headers; all calls 200.
- **Slug supply**: jobhive `rippling.csv` — **1,923 rows**, MIT (design marked UNKNOWN;
  it exists).
- **Build-readiness: READY**, effort M as planned (pagination loop + fetchDetail).
  **Confidence: medium-high** — mechanics all verified, but undocumented surface = standing
  fragility.

## SmartRecruiters — BLOCKED-LEGAL

`https://api.smartrecruiters.com/robots.txt` fetched 2026-07-17, verbatim and complete:

```
User-agent: LinkedInBot
Allow: /v1/companies/
User-agent: *
Disallow: /
```

Every agent except LinkedInBot is disallowed from the entire API host, including
`/v1/companies/{id}/postings`. Per the mission's legal line (and design §7), **the postings
API was never called** — no hit-rate batch was run, and the 4.6a hit-rate question is moot
unless the operator makes an explicit contrary legal call. `www.smartrecruiters.com/robots.txt`
additionally carries a long per-company `Disallow` list. jobhive has `smartrecruiters.csv`
(2,214 rows, MIT) but it is unusable under this posture. Evidence fixture:
`smartrecruiters-robots.txt`. **Verdict: BLOCKED-LEGAL — drop unless the operator overrides.**

## Slug supply (all vendors)

`github.com/kalil0321/ats-scrapers`, directory `ats-companies/`, licence **MIT** (LICENSE
fetched and read). Schema for every file: `name,slug,url`. Row counts (header excluded),
downloaded 2026-07-17:

| CSV | rows | design claim | note |
|---|---|---|---|
| workable.csv | 4,269 | ~4,269 | exact match |
| personio.csv | 2,463 | not claimed | new — design said careers-url funnel only |
| rippling.csv | 1,923 | not claimed | new |
| recruitee.csv | 888 | not claimed | new |
| pinpoint.csv | 350 | not claimed | new |
| smartrecruiters.csv | 2,214 | 2,214 | moot (blocked) |

Spot-check hit-rate: one mid-file slug per vendor (logifuture, snappet, wik, livelink,
novata) — **5/5 returned HTTP 200 with real postings**. Small sample; the Phase-2-style
validation pass remains the real filter (expect zombie boards — sendcloud — and dead
redirects — enpal-style 307s on Personio).

**Total nominal reach of the five viable vendors: 9,893 slugs** (4,269 + 2,463 + 1,923 +
888 + 350). Realistic post-validation reach is UNKNOWN until the validation pass runs; the
5/5 spot check and the design's greenhouse experience suggest most rows are live, but no
percentage is claimed here.

## Ranking (reach × ease × legal cleanliness) — build order

1. **Workable** — 4,269 slugs, one unauthenticated call per board returns everything incl.
   descriptions (`details=true`), boolean remote flag, stable `shortcode`, vendor-documented,
   robots fully open, no pagination, no rate limiting observed. Best on all three axes.
   (One design correction: don't trust the `function` field.)
2. **Personio** — 2,463 slugs (second-largest supply, newly confirmed), one-call XML feed
   with real `createdAt`, vendor-documented syndication, no robots restrictions. Costs: XML
   parsing, constructed job URL (pattern verified), string-heuristic remote signal.
3. **Rippling** — 1,923 slugs, richest detail payload (incl. application questions), clean
   robots. Costs: pagination loop, mandatory `fetchDetail` N+1 for descriptions, and an
   undocumented surface that can break silently. Reach justifies third despite fragility.
4. **Recruitee** — best payload of all (remote boolean + `published_at` + description in
   the list, vendor-documented) but only 888 slugs and a per-tenant robots regime that
   demands a robots gate per board. Ease is top-tier; reach is what ranks it fourth.
5. **Pinpoint** — cleanest legal footing, trivial connector, but 350 slugs and no
   posted-date field. Build it last, cheaply.
- **SmartRecruiters — dropped** (robots `Disallow: /` for all but LinkedInBot; API never
  called). Revisit only on an explicit operator legal decision.

This matches the design's §4.2 order except **Personio and Recruitee swap** (the newly
confirmed 2,463-row Personio CSV vs Recruitee's 888 + per-tenant robots overhead), and
Rippling moves ahead of Recruitee on reach.
