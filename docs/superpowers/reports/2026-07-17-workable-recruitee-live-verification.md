# Workable + Recruitee — Live Verification (Phase 4 operator prerequisite)

Date: 2026-07-17 (03:54–03:58 UTC). Scope: plan tasks 4.1a and 4.2a only
(docs/superpowers/plans/2026-07-17-decoupling-and-connectors.md — the two build-first
Phase-4 vendors; design §4.2 Tier 2 items 1–2). This is an independent pass with the
**production UA** `Mozilla/5.0 (compatible; caliber/1.0)` (`_http.ts:5` verbatim — the UA
the shipped connector will actually send), distinct from the earlier
`caliber-verify/1.0` pass recorded in `2026-07-17-connector-live-verification.md`. It
adds what that pass did not measure: **live multi-function title counts** and
**ATS-direct applyUrl confirmation** (legitimacy-scoring input).

Request ledger (complete): `apply.workable.com` — 4 requests (robots.txt + 3 board
calls). Recruitee — 8 requests across 4 tenant hosts (robots.txt + `/api/offers/` per
tenant, robots checked **before** each API call). `raw.githubusercontent.com` — 1 (slug
CSV; not a vendor host). Every response was HTTP 200. **No 403 or 429 was received.**
**No rate-limit headers** (`X-RateLimit-*`, `Retry-After`) appeared on any response.
LinkedIn/Indeed/Glassdoor/Wellfound/Getro were not touched.

Raw captures live in the session scratchpad (ephemeral); committed fixtures for both
vendors already exist from the earlier pass at
`.claude/worktrees/remote-source-matching-fix/src/server/search/connectors/__fixtures__/live-verify/{workable,recruitee}.json`.

## Verdict table

| Vendor | Verdict | Slugs verified live (offer counts) | Endpoint | Auth | Pagination | Descriptions | ATS-direct applyUrl |
|---|---|---|---|---|---|---|---|
| Workable | **VERIFIED** | apna (110), nuvei (57), pavago (1,572) | `GET apply.workable.com/api/v1/widget/accounts/{slug}` | none | none — 1,572 jobs in one 930,075-byte response | **only with `?details=true`** (absent from base list) | yes — `application_url` on `apply.workable.com` |
| Recruitee | **VERIFIED** (per-tenant robots gate stands) | blueforest (2), entyreinc (21), wohlbehagen (5), switchojob (4) | `GET {slug}.recruitee.com/api/offers/` | none | none observed; large-board behaviour UNKNOWN | inline (`description` + `requirements` in list) | yes — `careers_apply_url` on `{slug}.recruitee.com` |

## Workable — VERIFIED

- **Slugs**: `apna` and `nuvei` (design §4.2's gap-fill examples), `pavago` (the earlier
  pass's large board, re-verified). All 200 under the production UA.
- **Endpoint + auth**: `GET https://apply.workable.com/api/v1/widget/accounts/{slug}` →
  200, `application/json; charset=utf-8`, no credentials of any kind sent,
  `access-control-allow-origin: *` on API responses. Cloudflare-fronted
  (`server: cloudflare`, `cf-cache-status: DYNAMIC` on API, `HIT` on robots).
- **Pagination**: none. `pavago` returned **1,572 jobs in a single 930,075-byte
  response**; `apna` 110 in 72,874 bytes. No page/cursor parameter exists in the payload.
  Size is the flip side: a 1,500-job board with `details=true` will be multi-MB.
- **Descriptions — the base list has none.** Verified directly: apna without the param →
  `'description' in job` is **False** (19 keys, no description). With `?details=true`
  (nuvei) → 20th key `description` appears, 5,020-char HTML on job[0] ("Accountant").
  So: one call per board with `details=true`, **no N+1** detail call.
- **Job fields** (verbatim, identical 19-key shape on all three boards):
  `application_url, city, code, country, created_at, department, education,
  employment_type, experience, function, industry, locations, published_on, shortcode,
  shortlink, state, telecommuting, title, url` (+ `description` under `details=true`).
  `locations[]` items: `{country, countryCode, city, region, hidden}`.
- **ATS-direct applyUrl — confirmed**: `url` = `https://apply.workable.com/j/{shortcode}`
  (posting page), `application_url` = `https://apply.workable.com/j/{shortcode}/apply`
  (application form). Observed verbatim: `https://apply.workable.com/j/01B0CB39DD/apply`
  (apna), `https://apply.workable.com/j/52D79ECD9C/apply` (pavago). Both are on the ATS
  domain — exactly what legitimacy scoring needs; no aggregator redirect in the payload.
- **Multi-function breadth — live counts** (the core question this pass adds):
  - **pavago, 1,572 titles**, keyword-bucket counts (buckets can overlap; evidence not a
    taxonomy): finance/accounting **176** (Accountant, Accounting Manager | U.S. GAAP,
    AIA Billing Specialist…), sales/BD **231**, marketing **209**, engineering/dev/data
    **148**, HR/people/recruiting **43** (HR Specialist, Talent Acquisition Specialist…),
    exec/leadership **30** (Chief of Staff, Head of Engineering, Head of Client
    Operations…), legal **27** (Attorney, Paralegal, Compliance Officer, Legal
    Assistant).
  - **nuvei, 57 titles**: `Finance & Legal` department carries Accountant, Financial
    Controller, Compliance Officer, Legal Counsel ×4, Billing Analyst/Specialist ×3,
    Revenue Analyst, Underwriting Specialist, Portfolio Risk Analyst; exec titles
    "VP, Solutions and Implementations (Americas)" and "Head of Commercial Enablement
    APAC" ×2; SDR ×7.
  - **apna, 110 jobs**, the payload's own `function` field: Sales 52, Business
    Development 20, Engineering 5, Human Resources 3, Marketing 2, Product Management 1,
    Data Analyst 1, IT 1, Other 1, `''` 24.
  - Non-engineering roles dominate all three boards. Confirmed, with counts.
- **`function` field remains unreliable** (corroborates the earlier pass): nuvei's is
  `null` on most rows (its "Accountant" has `function: None`); apna's is populated but
  24/110 empty; `department` is richer but nullable too (apna 14 `None`). The plan's own
  function-tagging pipeline stays necessary.
- **Remote signal**: `telecommuting` boolean — apna 3/110 `true`, nuvei 12/57 `true`
  (incl. Legal Counsel, Compliance Officer, VP Solutions), pavago **1,571/1,572 `true`**
  (an all-remote staffing firm; also evidence the flag is real, not defaulted).
- **RawPosting mapping** (`connector.ts:17`): `externalId`←`shortcode` (stable, in the
  URL); `url`←`application_url`; `title`←`title`; `company`←top-level `name`
  ("Apna"/"Nuvei"/"Pavago" observed) or source row; `location`←`city`+`country` (+
  `locations[]` for `geo`); `geo.workMode`←`telecommuting===true` → `"remote"` (mirror
  `ashby.ts:34`); `postedAt`←`published_on` (date-only `"2026-06-27"`; `created_at` also
  present); `description`←`description` under `details=true`.
- **robots.txt** (`apply.workable.com/robots.txt`, 200, 78 bytes, verbatim and
  complete): `User-agent: *` / `Content-Signal: search=yes, ai-input=yes, ai-train=no` /
  `Disallow:` (empty → fully open). Unchanged from the earlier pass; `ai-train=no` is a
  model-training signal, not applicable to this crawler.
- **Slug supply**: jobhive `workable.csv` previously confirmed at 4,269 rows, MIT
  (`2026-07-17-connector-live-verification.md`); not re-downloaded in this pass.
- **Biggest caveat**: response size at scale (multi-MB single responses on large boards
  with `details=true`) — a stream-or-cap decision for the connector, not a blocker.

## Recruitee — VERIFIED (per-tenant robots gate stands)

- **Slugs**: `blueforest` (earlier pass's known-live board) + three **fresh mid-file
  picks** from jobhive `recruitee.csv` lines 200/400/800: `entyreinc`, `wohlbehagen`,
  `switchojob`. **4/4 robots-open, 4/4 returned 200 with real published offers** (2, 21,
  5, 4 offers) — a better hit-rate signal than the earlier pass's mixed draw (which found
  one zombie and one robots-blocked tenant; those weren't re-touched).
- **Robots checked per tenant, before each API call** (the earlier pass's finding,
  operationalised): all four read verbatim `User-Agent: *` / `Disallow: /v/` /
  `Sitemap: https://{slug}.recruitee.com/sitemap.xml` — `/api/offers/` is not blocked on
  any of them. The per-tenant regime is confirmed (four independent tenants, same
  policy), and the build requirement stands: **fetch `{slug}.recruitee.com/robots.txt`
  and skip `Disallow: /` tenants** (snappet-style) before calling the API.
- **Endpoint + auth**: `GET https://{slug}.recruitee.com/api/offers/` → 200,
  `application/json; charset=utf-8`, no credentials, `server: Cowboy`. No rate-limit
  headers on any of the four.
- **Response shape**: `{ offers: [...] }`, **56 keys per offer** (verbatim, blueforest):
  `careers_apply_url, careers_url, category_code, city, close_at, company_name, country,
  country_code, cover_image, created_at, department, description, dynamic_fields,
  education_code, employment_type_code, experience_code, guid, highlight, hybrid, id,
  location, location_question_visible, locations, locations_question,
  locations_question_required, locations_question_type, mailbox_email, max_hours,
  max_hours_per_week, min_hours, min_hours_per_week, on_site, open_questions,
  options_cover_letter, options_cv, options_phone, options_photo, options_salutation,
  options_title, position, postal_code, published_at, remote, requirements, salary,
  sharing_description, sharing_image, sharing_title, slug, state_code, state_name,
  status, tags, title, translations, updated_at`.
- **Descriptions inline — no N+1**: `description` (4,498 chars) **plus** a separate
  `requirements` field (10,515 chars) verified on blueforest's first offer; present on
  all four boards.
- **ATS-direct applyUrl — confirmed**: `careers_apply_url` =
  `https://{slug}.recruitee.com/o/{offer-slug}/c/new` (observed verbatim:
  `https://blueforest.recruitee.com/o/utility-partnerships-manager/c/new`);
  `careers_url` = the posting page. Both on the tenant's ATS host — legitimacy-scoreable.
- **Multi-function breadth — live counts** (32 offers across the 4 boards; department
  values verbatim): Sales & Customer Success 9, Clinical 8, Operations 3, Marketing 2,
  Verwaltung (DE: admin/finance/HR) 2, Pflegeheim 2, Engineering 1, Product 1, Sales 1,
  Science & Research 1, Project Development 1, Altenpflege 1. Non-eng titles observed:
  "Finanz- und Lohnbuchhalter" (finance/payroll accountant), "Personalkauffrau/mann"
  (HR administrator), "Director of Indigenous Partnerships", "State General Manager -
  Colorado/Texas/Pennsylvania", "Growth Marketing Manager", "Inbound Sales
  Representative", RN/nursing roles. **Only 1 of 32 offers is engineering.** No Legal
  title appeared in this 32-offer sample (absence of evidence at this sample size, not
  evidence of absence). Recruitee's base skews EU SMB / non-tech — strong for function
  breadth, thinner for the remote-startup persona per board.
- **Remote signal**: mutually-exclusive `remote`/`hybrid`/`on_site` booleans — observed
  split across the 32 offers: remote 5, hybrid 17, on_site 10 (accounts for all 32;
  `location: "Remote job"` / `"Homeoffice"` accompanies `remote: true`).
- **Salary — a field the earlier pass under-reported**: `salary` object with **string**
  numerics: `{max: '120000', min: '92000', period: 'year', currency: 'USD'}` (verbatim,
  blueforest) → maps to `RawPosting.salaryRaw`; parse defensively, values are strings.
- **RawPosting mapping**: `externalId`←`id` (int, e.g. `2665154`); `url`←`careers_url`
  (`applyUrl` candidate: `careers_apply_url`); `title`←`title`;
  `company`←`company_name` (present in every offer, e.g. "Blue Forest", "Entyre Inc");
  `location`←`location` (or `city`+`country`); `geo.workMode`←the three booleans;
  `postedAt`←`published_at` — **non-ISO** `"2026-07-02 17:18:08 UTC"` (all four boards),
  needs explicit parsing, `Date.parse` on it is not guaranteed; `salaryRaw`←`salary`;
  `description`←`description`+`requirements`.
- **Pagination**: none observed and none needed at these sizes (max sampled board: 21
  offers). Behaviour on a several-hundred-offer board remains **UNKNOWN** — unchanged
  from the earlier pass; the vendor docs' `department`/`tag` filters are the only known
  query params.
- **Slug supply**: jobhive `recruitee.csv` re-downloaded this pass — 889 lines incl.
  header = **888 slugs**, schema `name,slug,url` (matches the earlier pass exactly).
- **Biggest caveat**: the per-tenant robots gate is mandatory connector behaviour, not
  an ingest-time-only filter — a tenant can flip to `Disallow: /` at any time.

## Deltas vs the earlier pass (`2026-07-17-connector-live-verification.md`)

1. **Production UA verified**: both vendors serve the exact UA string the shipped
   connector sends (`_http.ts:5`) — the earlier pass used `caliber-verify/1.0`.
2. **Function breadth now has numbers**: pavago 1,572-title bucket counts and nuvei's
   Finance & Legal roster (Workable); 31/32 non-engineering offers across four Recruitee
   boards. Previously asserted from research notes, now measured live.
3. **ATS-direct applyUrl confirmed for both** — `application_url` (Workable) and
   `careers_apply_url` (Recruitee) observed verbatim on ATS-owned hosts.
4. **Workable base list has NO description** — verified by key-diff (apna without param
   vs nuvei with `details=true`). `details=true` is mandatory for 4.1b's one-call
   posture, per plan 3.0.
5. **Recruitee mid-file hit-rate 4/4** (incl. robots) vs the earlier mixed draw;
   `salary` string-typed numerics and the non-ISO `published_at` format called out as
   build-time parsing requirements.

Both vendors: **build-ready** (4.1b / 4.2b unblocked). No legal posture change — no 403,
no 429, robots open everywhere requests were sent.
