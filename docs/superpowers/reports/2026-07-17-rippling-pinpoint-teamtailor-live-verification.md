# Live Verification — Rippling, Pinpoint, Teamtailor

Date: 2026-07-17. Scope: plan 2026-07-17-decoupling-and-connectors.md Phase 4 (tasks 4.4a
Pinpoint, 4.5a Rippling) + design §4.2 Tier 2 Teamtailor bullet (RSS mechanics were
confirmed there; **multi-function breadth was not** — resolving that was this pass's
priority). All claims below are grounded in HTTP responses received 2026-07-17
(~03:55–04:20 UTC) with UA `Mozilla/5.0 (compatible; caliber/1.0)` — the exact string in
`src/server/search/connectors/_http.ts:5` — no auth, no header spoofing, single requests
with 1–2 s delays, ≤10 requests per vendor. **No 403 or 429 was received from any
vendor.** No rate-limit headers (`X-RateLimit-*`, `Retry-After`) were observed on any
response (grepped across every captured header file).

Relationship to `2026-07-17-connector-live-verification.md` (worktree
`remote-source-matching-fix`): that report established Pinpoint/Rippling mechanics the
same morning. This pass independently re-verified the spec's specific claims (Rippling:
undocumented surface, N+1 descriptions; Pinpoint: payload shape, no posted date), added
**function-breadth title counts** for all three, and covers Teamtailor for the first time.
Raw captures live in the session scratchpad; key payloads are quoted verbatim below.

## Verdict table

| Vendor | Verdict | Slugs verified live | Endpoint | Auth | Pagination | Descriptions | ATS-direct applyUrl | Slug supply (jobhive, MIT) |
|---|---|---|---|---|---|---|---|---|
| Rippling | **VERIFIED** (undocumented surface + N+1 both confirmed) | joinroot (12), northern-montana-hospital (118, 6 pages) + 1 detail call | `GET ats.rippling.com/api/v2/board/{slug}/jobs` (+`?page=N`), detail `…/jobs/{id}` | none | **yes** — `page` (0-indexed), `pageSize: 20`, `totalItems`, `totalPages`; `?page=1` returned distinct items | **detail only (N+1)** | yes — `ats.rippling.com/{slug}/jobs/{uuid}` in the list | 1,923 |
| Pinpoint | **VERIFIED** (no postedAt; exactly-1,000 cap suspicion re-observed) | workwithus (3), summitk12 (7), trilongroup (1,000) | `GET {slug}.pinpointhq.com/postings.json` | none | none documented; trilongroup = **exactly 1,000 rows for the second time today** (cap UNKNOWN) | inline | yes — `{slug}.pinpointhq.com/en/postings/{uuid}` | 350 |
| Teamtailor | **VERIFIED** (breadth RESOLVED; per-tenant Content-Signal gate required) | polestar (25), luminorbank (84), paysend (8), unobravo (7); funnel (0, valid empty), worldbank (404) | `GET {slug}.teamtailor.com/jobs.rss` (RSS/XML) | none | none observed through 84 items (cap beyond that UNKNOWN) | inline (full HTML) | yes — `{slug}.teamtailor.com/jobs/{id}-{title-slug}` | **1,010** (new — design and prior report had no number) |

## Rippling — VERIFIED (both spec caveats confirmed real)

- **Slugs**: `joinroot` (the design's example — 200, 12 jobs, 1 page),
  `northern-montana-hospital` (mid-file pick from jobhive `rippling.csv` line 960 — 200,
  `totalItems: 118`, `totalPages: 6`). One detail call on joinroot's first job.
- **List endpoint**: `GET https://ats.rippling.com/api/v2/board/{slug}/jobs` → 200, no
  auth. Envelope keys verbatim: `items, page, pageSize, totalItems, totalPages`;
  `pageSize: 20`, `page` **zero-indexed** (default response echoes `page: 0`).
  Pagination re-verified live: nmh `?page=1` → `page: 1` echoed, 20 items, first item id
  distinct from page 0's.
- **List item fields** (verbatim, complete): `department{name}, id (uuid), language,
  locations[{…, workplaceType}], name, url`. **No description, no date, no company name**
  — the spec's N+1 claim is confirmed from the list side.
- **Detail endpoint (the N+1)**: `GET …/board/joinroot/jobs/{id}` → 200, 19,822 bytes.
  Keys verbatim: `activeJobApplication, applicationConfirmationTemplate, board,
  companyName, createdOn, department, description, eeocQuestionnaireEnabled,
  eeocQuestionnaireEnabledForJobPost, employmentType, hasAIEvaluationsEnabled, jsonLd,
  name, payRangeDetails, unlistedFromSearch, url, uuid, workLocations`. `description` is
  an **object keyed by section** — observed `{company, role}`, 14,801 chars of HTML
  total. `createdOn: "2026-07-14T10:45:51.914000-07:00"` (ISO with tz);
  `companyName: "Root Insurance"`; `activeJobApplication.{basicQuestions,
  additionalQuestions}` (future `extractQuestions` material). Descriptions, dates and
  company names exist **only** here → `fetchDetail` is required, scoring-time only, never
  at crawl (plan 4.5a's budget rule stands).
- **Function breadth — live titles (joinroot, all 12)**: Sr. Financial Analyst (**CFO
  Org** — Finance), Client Legal Services Attorney (**Legal**, Insurance Operations),
  Marketing CRM Lead (**Public Relations & Communications**), Sr. Manager, Major Case
  Investigative Unit (Insurance Operations), Senior Product Manager, Pricing (Product &
  Design), Director of Data Science (Quantitative Science — exec-level), 2× Insurance
  State Manager (Decision Science), Lead ML Engineer, 3× Engineering. **Non-eng = 8 of
  12.** nmh's 118 are healthcare-board-shaped (Clinical Nursing, Business Services —
  Clerk-Biller). The endpoint exposes the whole board regardless of function; breadth is
  company-shaped, confirmed.
- **RawPosting mapping** (`connector.ts` shape): `externalId`→`id`; `title`→`name`;
  `url`→`url` (ATS-direct, in the list); `location`→`locations[0].name`;
  `geo.workMode`→`locations[].workplaceType === "REMOTE"` (all 12 joinroot jobs carried
  `REMOTE`); `company`→source row at crawl (detail `companyName` at scoring);
  `description`/`postedAt`→detail only (fallback: pool `firstSeenAt`).
- **Undocumented surface — confirmed, with a ToS blank**: every response carried
  `x-middleware-rewrite: http://api.rippling.internal/api/ats2_provisioning//api/v2/board/joinroot/jobs`
  — this is an internal service rewrite, i.e. the surface is not a published API.
  `ats.rippling.com/robots.txt` verbatim and complete: `User-agent: *` /
  `Disallow: /internal/` — the board API path is not robots-blocked. **ToS scrutiny
  (flagged, not rationalized)**: no public terms document governing this host could be
  located — `www.rippling.com/legal` (200) lists only product-specific terms hosted on
  `app.rippling.com` (contractor-hub, credit-line, timeclock);
  `www.rippling.com/terms`, `/legal/terms-of-service`, `/legal/website-terms-of-use` all
  404. **The terms governing `ats.rippling.com` are UNKNOWN — there is no discoverable
  document to clear against**, unlike Getro (explicit prohibition, out) or Workable
  (vendor-documented, in). Combined with the internal-service header, this stays exactly
  where the plan put it: the operator accepts the fragility + legal posture at 4.5a, with
  `consecutiveFailures` → dead as containment; this report does not upgrade that posture.
- **Rate limits**: none observed; Cloudflare-fronted (`__cf_bm` cookie). All calls 200.
- **Request count this pass**: 5 to `ats.rippling.com` (robots, 2 list, 1 page-1, 1
  detail) + 4 to `www.rippling.com` (ToS probes).

## Pinpoint — VERIFIED (postedAt gap and 1,000-row anomaly both re-observed)

- **Slugs**: `workwithus` (Pinpoint's own board — 3 postings), `summitk12` (fresh
  mid-file pick from jobhive `pinpoint.csv` line 280 — 7 postings), `trilongroup`
  (**exactly 1,000 postings, 7.1 MB — the same exact count the earlier report saw**,
  which now looks even more like a silent cap; still UNKNOWN, no pagination param is
  documented to test against).
- **Endpoint + status**: `GET https://{slug}.pinpointhq.com/postings.json` → 200,
  `application/json`, no auth, one call per board.
- **Response shape**: `{ data: [...] }`. Posting keys verbatim (25, identical across all
  three boards): `benefits, benefits_header, compensation, compensation_currency,
  compensation_frequency, compensation_maximum, compensation_minimum,
  compensation_visible, deadline_at, description, employment_type, employment_type_text,
  id, job, key_responsibilities, key_responsibilities_header, location, path,
  reporting_to, skills_knowledge_expertise, skills_knowledge_expertise_header, title,
  url, workplace_type, workplace_type_text`.
- **Gap re-confirmed — no posted date**: no key matching create/post/publish exists in
  any sampled payload; `deadline_at` was `null` on every sampled posting. Fallback is the
  pool's `firstSeenAt`, reported as a gap, not papered over.
- **ATS-direct applyUrl**: `url` is absolute on the ATS domain —
  `https://{slug}.pinpointhq.com/en/postings/{uuid}` (note the **`/en/` locale segment**,
  not noted in the earlier report; treat the path as opaque, use `url` verbatim).
- **Function breadth — live counts**: `summitk12` (7): **Sales 3** (Business Development
  Representative, 2× Account Executive), **Marketing 2**, Product Management 2,
  **engineering 0** — a non-eng-majority board. `trilongroup` (1,000): departments led by
  Transportation 323 / Civil-Municipal 164 (it is an infrastructure consultancy); title
  regex counts: **Finance/Accounting 13** (Project Accounting Manager, Project
  Accountant…), **exec (VP/Chief/Director/Head-of) 28** (Senior Transportation Director…),
  **HR/recruiting 4** (Senior Recruiter…), Sales/BD 1, Marketing 1; Legal 0 (the 2 regex
  hits are "Environmental Compliance Engineer" — not legal roles). Conclusion: the
  endpoint exposes **the full board across functions**, but the sampled tenant base
  (workforce dev, K-12, hospitals, infra consultancies, Pinpoint itself) skews
  non-startup — the design's "startup-function breadth thin" caveat stands on the tenant
  mix, not the API.
- **Remote signal**: `workplace_type` — workwithus 3/3 `remote`; summitk12 6 `remote` /
  1 `onsite`; trilongroup `onsite: 560, hybrid: 410, remote: 30`.
- **Legal**: `workwithus.pinpointhq.com/robots.txt` verbatim: `User-Agent: *` /
  `Disallow: /mydata` / `Disallow: /admin` / `Disallow: /companies` — `postings.json`
  untouched. Vendor-documented endpoint (developers.pinpointhq.com, per the earlier
  report). Still the cleanest legal footing of the three.
- **Operational note**: the first trilongroup attempt failed DNS
  (`Could not resolve host`) and resolved normally minutes later — transient, but a
  reminder that the freshness loop should treat one NXDOMAIN as a failure count, not
  instant death.
- **Request count this pass**: 5 (robots, 3 boards, 1 failed-DNS retry).

## Teamtailor — VERIFIED (the breadth question is RESOLVED: full board, all functions)

The design confirmed RSS mechanics on a single design-agency sample and left
multi-function breadth open. Four live tenants close it.

- **Slugs** (from jobhive `teamtailor.csv` — 1,010 rows, a supply neither the design nor
  the earlier report knew existed): `polestar` (200, 25 items), `luminorbank` (200, 84
  items), `paysend` (200, 8 items), `unobravo` (mid-file pick, 200, 7 items); `funnel` →
  200 but **0 items** (valid empty channel — zombie-board shape); `worldbank` → **404**
  (dead slug). Hit-rate: 5/6 valid RSS, 4/6 non-empty.
- **Endpoint + status**: `GET https://{slug}.teamtailor.com/jobs.rss` → 200,
  `application/rss+xml; charset=utf-8`, no auth. (The keyed REST API was not touched —
  no auth surface used.) Whether the RSS feed is vendor-documented was not checked in
  this pass — **UNKNOWN**.
- **Item shape** (verbatim, uniform across all 25+84+8+7 items): `title, description,
  pubDate, link, remoteStatus, guid, company_name, company_uuid` + namespace
  `xmlns:tt="https://teamtailor.com/locations"`: `tt:locations > tt:location >
  {tt:name, tt:address, tt:zip, tt:city, tt:country}`, `tt:department`, `tt:role`.
  Observed values: `tt:name "Seoul, South Korea"`, `tt:city "Seoul"`, `tt:country
  "South Korea"` — **structured location is present** (empty container text is a parsing
  trap; the data is in child elements).
- **Descriptions**: **inline, full HTML** in `<description>` (4,879 chars on polestar's
  first item) — no N+1 call needed.
- **postedAt**: `pubDate` RFC 822 with tz (`Thu, 09 Jul 2026 08:25:51 +0200`).
- **Function breadth — live counts (the headline finding)**:
  - `polestar` (25): Customer Experience 6, **Global Sales 6**, **Finance 3** (Tax
    Manager, Liquidity Manager — Treasury, Team Lead Group Consolidation),
    **Communications & PR 3**, Brand & Marketing 2, Design 1, untagged 4. Legal present
    by title (Rechtsreferendar — Legal Commercial). **One software title in 25.**
  - `luminorbank` (84): Technology 45, **Retail Banking Marketing 12**, Corporate
    Banking 8, **Retail Banking Sales 7**, Operations 4, **Finance 3**, **Risk 3**,
    **Internal Audit 1**.
  - `paysend` (8): Compliance & Risk 1 (Senior Compliance Analyst), exec titles in the
    untagged set (Director Network Development and Partnerships, **Global Head of**
    Network Development), CRM Growth Manager, Global Performance Marketing Manager.
  - `unobravo` (7): all Team Clinico (psychologists) — a single-function **company**,
    not a feed limitation.
  The RSS is the whole public board, every function, with `tt:department` attached.
  The "only sample was a design agency" gap is closed.
- **Remote signal**: `remoteStatus` element, observed value set `{none, hybrid, fully,
  temporary}` — `fully` = fully remote (unobravo 3), `hybrid` common; `temporary`
  observed once (paysend) and its semantics are **UNKNOWN** — map only `fully`→remote,
  `hybrid`→hybrid, treat others as unknown, fail nothing.
- **Per-location item expansion**: one posting in N cities appears as N items with the
  same title but **distinct `guid` and `link`** (luminorbank "Software Engineer (iOS)"
  3× — Tallinn/Riga/Vilnius, three ids). Dedupe key is `guid` (or the numeric id in the
  link path); this matches the pool's location-bucket behaviour, not a bug.
- **ATS-direct applyUrl**: `link` =
  `https://{slug}.teamtailor.com/jobs/{numericId}-{title-slug}` — on the ATS domain,
  good for legitimacy scoring. Caveat: tenants with custom career domains exist
  (funnel's robots 301s to `jobs.funnel.io`), where `link` would carry the custom
  domain; `/jobs.rss` itself served 200 on the `{slug}.teamtailor.com` host without
  redirecting on every sampled tenant.
- **Legal — per-tenant Content-Signal, the build requirement of this vendor**: robots
  path rules are uniform and permissive across sampled tenants (`Disallow: /app/,
  /messages/, /messenger/, /facebook/tab/, /jobs/internal/` — `/jobs.rss` never
  blocked; UA `aihitdata` is fully disallowed — not us). But the `Content-Signal` line
  **differs per tenant**: polestar declares `search=no, ai-train=no, ai-input=no`;
  paysend and luminorbank declare `search=yes, ai-train=no, ai-input=yes`. Caliber
  feeds JD text into an LLM scoring pipeline — that is the `ai-input` class. Applying
  the same honest reading that credited Workable's permissive signal: **a tenant
  declaring `ai-input=no` must be skipped.** The connector needs a per-tenant robots +
  Content-Signal gate, exactly the Recruitee posture with one extra field parsed.
  Flagged as a hard gate, not rationalized away: polestar's data above is used here as
  verification evidence only and its board should be gated out of standing ingestion.
- **Validation posture**: require ≥1 item (funnel-style valid-empty feeds and
  worldbank-style 404s both exist in the CSV supply).
- **Connector cost**: XML parsing — the same `fast-xml-parser` vs hand-rolled decision
  the plan already assigns to Personio (4.3a); one decision covers both vendors.
- **RawPosting mapping**: `externalId`→`guid`; `url`→`link`; `title`→`title`;
  `company`→`company_name`; `location`→`tt:location/tt:name` (+`tt:city`/`tt:country`
  for geo); `geo.workMode`→`remoteStatus === "fully"` ? remote : `"hybrid"` ? hybrid;
  `postedAt`→`pubDate`; `description`→`description` HTML through `htmlToText`.
- **Request count this pass**: 10 (4 robots incl. one 301, 6 RSS incl. the
  custom-domain check).

## Slug supply (this pass)

jobhive (`github.com/kalil0321/ats-scrapers`, `ats-companies/`, MIT), downloaded
2026-07-17, schema `name,slug,url`, rows exclude header:

| CSV | rows | prior report | note |
|---|---|---|---|
| rippling.csv | 1,923 | 1,923 | match |
| pinpoint.csv | 350 | 350 | match |
| teamtailor.csv | **1,010** | not checked | **new** — second-largest supply of the three; larger than Recruitee's 888 |

Live spot-check hit-rate across the three vendors this pass: 8 boards returned real
postings, 1 returned a valid empty feed, 1 was a dead 404, 1 had a transient DNS
failure. Consistent with the earlier report: most rows live, zombie/dead rows exist,
the Phase-2 validation pass is the real filter.

## Where Teamtailor slots in the build order

The earlier report's ranking (Workable → Personio → Rippling → Recruitee → Pinpoint)
stands. Teamtailor now has verified mechanics, verified all-function breadth, 1,010
slugs, inline descriptions, structured locations, a real posted date, and a
remote-ish signal — payload quality comparable to Recruitee with more reach — at the
cost of XML parsing (shared with Personio) and a per-tenant Content-Signal gate
(shared shape with Recruitee's robots gate). On reach × ease × legal it slots
naturally **alongside or just after Personio, ahead of Recruitee and Pinpoint**;
sequencing is the operator's call, and it needs a plan task (none exists — the plan's
Phase 4 currently stops at SmartRecruiters).
