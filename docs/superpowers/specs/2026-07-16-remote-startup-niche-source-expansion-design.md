# Remote-Startup Niche & Source Expansion — Design Spec

Date: 2026-07-16. Status: **operator-approved design, pre-implementation.**
Grounding: Opus code deep-read + a 7-modality web-research fan-out with adversarial
verification (4 of 7 sweeps completed; 74 sources, 5 verdicts), Fable synthesis — all 2026-07-16.
Supersedes the niche framing in `2026-07-11-caliber-standalone-design.md` §11 (see §9).

## 1. Summary

Caliber's niche becomes **a global remote-startup job portal spanning every job
function** — engineering, product, design, operations, finance, legal, marketing,
sales, people/HR, customer success, and executive. The operator's rule: *"as long as
we have a résumé, the job should be visible."* The Malaysia/SEA-local persona stays,
alongside the remote persona, unchanged.

The central finding: **the source layer was never tech-only — the company list was.**
ATS board APIs are *company*-scoped, not *function*-scoped. A live fetch of Stripe's
Greenhouse board returned **525 open roles, 54–77% of them non-engineering** (86 sales,
71 ops, 36 finance, 31 marketing, 28 CS, 20 legal, 11 HR, 6 strictly exec-titled
including "Chief Compliance Officer (APAC)" and "Head of Finance Operations"). Lever
confirmed the same on SEA companies. The three ATS connectors already shipped
(`greenhouse`, `lever`, `ashby`) therefore *already* reach the entire niche. They are
pointed at 12 companies.

So this program does not add many connectors. It (a) fixes the two code paths that
structurally reject the new niche, (b) builds a **company-list engine** that takes the
seeded list from 12 → 1,500–4,000 verified remote startups using MIT-licensed public
datasets and the connectors that already exist, and (c) **decouples ingestion from
per-user matching** — a global crawler filling a shared postings pool — because
per-user scan-time fan-out across ~1,000 boards does not survive contact with reality.

## 2. Operator-locked decisions (2026-07-16 — do not re-litigate)

| # | Decision | Value |
|---|----------|-------|
| 1 | Niche | Global **remote startups, all job functions** (incl. exec); SEA-local persona retained |
| 2 | Matching | **Two-stage**: de-biased cheap title/function filter (~thousands → ~200) → cheap LLM function classifier → deep LLM `scoreMatch` on ~40 |
| 3 | Scope | **Full program**: matching fix + company-list engine + ingestion/matching decoupling |
| 4 | Coverage strategy | **More companies, not more function-boards.** Single-function boards are Tier 3 (see §4.2) |
| 5 | Per-user `jobs` | **Kept** (multitenancy decision intact) — re-cast as the materialized *match view*, not the posting universe |
| 6 | JobStreet | **Kept, capped, not scaled.** Local-persona growth goes via Glints instead (§7) |
| 7 | Blocked sources | LinkedIn, Indeed, Glassdoor, Wellfound, Remotive — never (§4.2 Tier 3) |

## 3. Grounding (verified in code / live, 2026-07-16)

**Verified by reading the code:**
- `src/server/search/connector.ts` — `SourceConnector { id, kind:'ats'|'board'|'manual', persona, discover(ctx) → AsyncIterable<RawPosting>, fetchDetail?, extractQuestions? }`.
- `src/server/persistence/seed.ts:22-33` — **12 employer rows**, all tech startups. `config.connector` is the FACTORIES key; `config.slug` the company slug; `config.geo = {scope, regions?}`.
- `src/server/search/connectors/index.ts` — one connector fans out across many employer rows. Registry: greenhouse, lever, ashby, jobstreet (+fixture under test doubles).
- `src/server/persistence/repos/sources.ts` — sources are **global admin-managed reference data**, no `userId`.
- `src/server/search/run.ts:33` `TOP_N_CANDIDATES = 30`; `:34` `SCORE_CONCURRENCY = 3`; `:61` `DEFAULT_CONCURRENCY = 8`; `:535` `pool.slice(0, TOP_N_CANDIDATES)`.
- `src/server/persistence/schema.ts:176` — `unique(userId, dedupeKey)` on `jobs`.
- `src/server/search/connectors/jobstreet.ts` — calls SEEK's **unauthenticated `jobsearch/v5` JSON API** + public `/graphql jobDetails`, honest self-identifying UA `Mozilla/5.0 (compatible; caliber/1.0)`, capped ~3 pages × 30 = ~90 postings. Does **not** scrape the Cloudflare-walled SSR page.

**Verified by running the code** — `roleFuzzyMatch` against a *literally identical* posting title:

```
REJECT | "CEO"               (tokens: [])             vs "CEO"
REJECT | "CFO"               (tokens: [])             vs "Chief Financial Officer"
REJECT | "Chief of Staff"    (tokens: [])             vs "Chief of Staff"
REJECT | "Head of Finance"   (tokens: ["finance"])    vs "Head of Finance"
REJECT | "Head of Operations"(tokens: ["operations"]) vs "Head of Operations"
REJECT | "VP of Marketing"   (tokens: ["marketing"])  vs "VP of Marketing"
REJECT | "Recruiter"         (tokens: ["recruiter"])  vs "Recruiter"
MATCH  | "Operations Manager" · "Product Manager" · "Financial Controller"
       | "Account Executive"  · "Customer Success Manager" · "Backend Engineer"
```

Two root causes in `src/server/search/roleMatch.ts` (both inherited from the donor's
`roleFuzzyMatch`, which was built for engineers):
1. `roleTokens()` drops any word ≤3 chars unless in `SHORT_SPECIALTY` — a list that is
   *entirely tech acronyms* (`api,sre,sdk,cli,gpu,cpu,ios,qa,ux,ui,ar,vr,ocr,crm,erp`).
   So `CEO/CTO/CFO/COO/VP` tokenize to `[]`, and `titleTokens.length === 0` returns
   `false` immediately. **A CEO's résumé currently matches nothing in the universe.**
2. The `overlap.length < 2` rule kills single-token roles. `head`/`chief`/`of` are
   stopwords, so "Head of Finance" → `["finance"]` — one token can never reach two
   overlaps. Same for Recruiter, Controller, Paralegal, Copywriter.

**Verified live (web):** `boards-api.greenhouse.io/v1/boards/stripe/jobs` → HTTP 200,
525 roles, 54–77% non-eng. `kalil0321/ats-scrapers` CSVs downloaded: **greenhouse 4,966
+ ashby 2,856 + lever 2,113 slugs**, MIT licence confirmed via GitHub API, schema
`name,slug,url` (e.g. `Ramp,ramp,https://jobs.lever.co/ramp`). SEA slugs live-verified:
`GoToGroup` (lever), `shopback-2` (lever), `bjakcareer` (ashby). **Aspire's slug is NOT
`aspire`** — 404'd live.

**Research gap — CLOSED (gap-fill sweep, 2026-07-16).** The ATS-platform and
exec/fractional sweeps that first died were re-run as standalone agents (the Workflow
orchestrator crashed mid-run twice — agents healthy, parent process gone — so they were
respawned directly). Both completed with live-endpoint verification. Results are folded
into §4.2 Tier 2 (Workable et al. — mechanics now confirmed, not UNKNOWN) and §8 (the
exec ceiling). Remaining unknowns are narrow and named there (Pinpoint function-breadth
on a thin sample; Consider's obfuscated endpoint) — SmartRecruiters is dropped outright
(§4.2/§7, SAP API Policy prohibition) and Teamtailor's function-breadth was resolved live
across four tenants (§4.2), so neither is an open unknown anymore.

## 4. Design

### 4.1 Stage 1 — Matching fix (the gate that ships the old niche)

Nothing else is safe to ship before this: every seeded company funnels through
`roleMatch`, so expanding sources first means paying to ingest ops/finance/exec
postings that are then silently discarded.

**De-bias `roleTokens`.** The ≤3-char rule plus a tech-only acronym allowlist is the
bug. Replace with: keep tokens ≥2 chars, and treat a curated set of *role* acronyms
(`ceo,cto,cfo,coo,cmo,cro,cpo,vp,gm,hr,pm,bd,ae,sdr,csm,fp&a` …) as first-class
alongside the existing tech ones. `SHORT_SPECIALTY` becomes function-agnostic.

**Kill the `overlap.length < 2` floor for discriminating single tokens.** A single
*non-baseline* token ("finance", "operations", "marketing", "recruiter") that matches
is real signal — the floor exists to stop `["engineer"]`-style baseline collisions,
which `BASELINE_TOKENS` already handles. Rule becomes: ≥1 shared **non-baseline**
token, and drop the blanket ≥2 requirement when the sole overlap is non-baseline.

**Function tagging.** Stage-1 assigns a coarse `function` (eng/product/design/ops/
finance/legal/marketing/sales/people/cs/exec) from title tokens; a cheap LLM classifier
resolves only the ambiguous ones on the ~200 survivors. Deep `scoreMatch` runs on ~40.

**Deterministic ranking before any slice — the second bug.** `run.ts:535`
`pool.slice(0, TOP_N_CANDIDATES)` slices a Map in **insertion order**, i.e. whichever
connector won the 8-wide `pLimit` race. At 12 companies this never bites (fewer than 30
candidates). At 1,000 it deep-scores **30 arbitrary postings chosen by network race
order** — expansion would make results *worse and non-deterministic*. Sort stage-1
survivors by `(stage1Score desc, postedAt desc, stableKey asc)` before the slice.
**Map-insertion order must never reach the slice.**

### 4.2 Tiered source architecture

**Tier 1 — do first (all reachable with existing connectors):**

| Source | Non-eng value | Effort | Risk |
|---|---|---|---|
| **jobhive CSVs** — 9,935 slugs across greenhouse/ashby/lever | Every function at every company; **zero new connector code** | S | MIT; same public APIs already called |
| **Verified SEA seeds** — `GoToGroup`, `shopback-2`, `bjakcareer` | SEA + function-diverse, slugs live-verified | S | None. Resolve Aspire's real token first |
| **yc-oss/api** (6,043 YC cos, daily JSON, `isHiring`) + **remoteintech/remote-jobs** (881 cos, ships `careers_url` on 69.2%, 40k★, pushed 2026-07-15) <!-- corrected 2026-07-17: topstartups.io dropped, remoteintech licence + structure corrected, yc-oss licence decision recorded — see src/server/sources/nicheList.ts (module header) and docs/superpowers/plans/2026-07-17-source-engine-ignition.md Risks (D8) --> | Startup/remote signal; `careers_url` feeds ATS auto-detection (1.7% point directly at an ATS board; §4.3 step 5) | S | yc-oss has **no LICENSE file at all** (`license: null` via the GitHub API) — operator decision: **fetch at runtime, do not vendor**, so no redistribution question arises. remoteintech's licence is **ISC** (LICENSE file confirmed, not NOASSERTION) and its repo has **restructured**: no longer a README table, now **881 entries at `src/companies/*.md`** with YAML frontmatter (`title, slug, website, careers_url, region, remote_policy, company_size, technologies`) — safe to vendor. |

**Tier 2 — new connectors, in verified priority order** (gap-fill research 2026-07-16
resolved the mechanics; these are no longer UNKNOWN):

1. **Workable** — *build this first among new connectors.* Live-verified:
   `GET apply.workable.com/api/v1/widget/accounts/{slug}` (`?details=true` for full HTML
   description), **no auth**, `robots.txt` fully open (`Disallow:` empty). Payload carries
   a **`function` field** *and* `department`, `telecommuting` bool, `locations[]`,
   `application_url`, stable `shortcode`, full description. All-function coverage confirmed
   by **two independent research runs** (Apna 139: sales/marketing/eng/product/data/HR/ops;
   Pavago 200: Attorney/Accountant/Legal/Design; Nuvei 68: Finance & Legal incl. Compliance
   Officer, Legal Counsel, VP Solutions). **Vendor-documented** — Workable's own help centre
   publishes this endpoint for building custom careers pages, the strongest legal footing of
   any ATS surveyed. ~4,269 slugs already in jobhive; survived adversarial verification
   (CONFIRMED). No pagination param (full list in one call). Effort **S**.
   <!-- corrected 2026-07-17: see reports/2026-07-17-connector-live-verification.md
   (Workable section). --> **Correction: the `function` field is mostly empty/null in
   practice** — nuvei's 57 jobs carried `['', 'Business Analyst', 'Data Analyst',
   'Engineering', 'Financial Analyst', 'Legal', None, 'Product Management']`, and pavago's
   1,572 jobs carried only `''` and `'Legal'`. Do not treat it as a shortcut for the
   Phase-3 function classifier — it does not reliably substitute for one.
2. **Recruitee** — `GET https://{slug}.recruitee.com/api/offers/`, no auth, **officially
   vendor-documented** as the "Careers Site API" (built for third-party embedding). Full
   text + `careers_apply_url` + remote flag. Effort **S**.
   <!-- corrected 2026-07-17: see reports/2026-07-17-connector-live-verification.md
   (Recruitee section). --> **Correction: `robots.txt` is per-tenant, not global** —
   `blueforest.recruitee.com/robots.txt` allows `/api/offers/`, but
   `snappet.recruitee.com/robots.txt` is `Disallow: /` for the whole board. A connector
   needs a per-board robots gate (§4.4a/b of the ignition plan), not a blanket assumption
   the API path is open.
3. **Personio** — `GET https://{slug}.jobs.personio.com/xml?language=en`, no auth,
   vendor-documented syndication feature, all-functions confirmed live (1NCE: CEO/COO/CTO
   Office depts incl. Accounting, Legal, Marketing). **XML not JSON** (small parser cost);
   remote is embedded in the office string, no boolean flag. Effort **S–M**.
4. **Pinpoint** — `GET https://{slug}.pinpointhq.com/postings.json`, no auth, **the
   cleanest legal footing found** (officially documented "Job Postings JSON Endpoint",
   CORS-open by design, `robots.txt` doesn't block it). Function-coverage breadth
   confirmed only on a thin live sample. Effort **S**.
5. **Rippling** — `GET https://ats.rippling.com/api/v2/board/{slug}/jobs`, no auth,
   all-functions confirmed live (joinroot: CFO Org, Product & Design, PR & Comms, …). Four
   caveats: **undocumented surface** (Rippling's official docs point to a gated host);
   <!-- corrected 2026-07-17: see reports/2026-07-17-connector-live-verification.md
   (Rippling section). --> **paginated, not a single call** — the envelope is
   `{items, page, pageSize:20, totalItems, totalPages}` (Rippling's own 780-job board costs
   39 list calls); and the list response carries no description/date/company, so
   **descriptions require an N+1 call** per posting (`/jobs/{id}`), which is also where
   `createdOn` and `companyName` live.
   <!-- corrected/added 2026-07-17: see reports/2026-07-17-handoff-integration.md
   (§1, Rippling ToS caveat). --> **governing ToS undiscoverable** — `www.rippling.com/terms`,
   `/legal/terms-of-service`, `/legal/website-terms-of-use` all 404; no public terms
   document governing `ats.rippling.com` could be located. §7 class: **Grey** (no explicit
   prohibition, unlike Getro/SmartRecruiters below) — **conditional: build only after the
   operator explicitly records acceptance of the ToS-blank**, else defer to last in the
   build order. Effort **M**.
- **SmartRecruiters** — *dropped, not merely downgraded.*
  `api.smartrecruiters.com/robots.txt` reads `User-agent: LinkedInBot / Allow:
  /v1/companies/` then `User-agent: * / Disallow: /` — an explicit allowlist this crawler
  is not on.
  <!-- corrected 2026-07-17: see reports/2026-07-17-connector-live-verification.md
  (SmartRecruiters section). --> **Correction: the postings API was never called** under
  this posture — no hit-rate batch was run, so the "5 of 7 jobhive slugs tested returned
  zero postings" data point predates the robots review and should not be read as a green
  light to test further. 2,214 slugs on paper, but the hit-rate question is **moot**
  unless the operator makes an explicit contrary legal call; do not build this connector.
  <!-- corrected/added 2026-07-17: see reports/2026-07-17-handoff-integration.md
  (§3 item 1, SAP API Policy citation). --> **Binding legal reason:** SmartRecruiters'
  developer docs state "any use of SmartRecruiters APIs is governed by the SAP API
  Policy"; the policy's **§2.2.2** expressly prohibits (a) API use by "(semi-)autonomous
  or generative AI systems that plan, select, or execute sequences of API calls" and
  (b) "scraping, harvesting, or systematic and/or large-scale data extraction or
  replication" (binds "third parties", not just customers); **§3** prohibits
  circumventing API controls "including through … impersonation techniques", foreclosing
  the LinkedInBot carve-out. This is the same standard §7 applies to Getro (verbatim
  reviewed prohibition → Dangerous, dropped) — SmartRecruiters carries *more* signals
  than Getro (ToS + API policy + a targeted robots `Disallow: /`).
- **Positive finding (added 2026-07-17; totals recomputed 2026-07-17 to include
  Teamtailor):**
  <!-- see reports/2026-07-17-connector-live-verification.md ("Slug supply (all vendors)")
  and reports/2026-07-17-rippling-pinpoint-teamtailor-live-verification.md (Teamtailor).
  Recomputed by fetching each jobhive CSV directly (2026-07-17):
  raw.githubusercontent.com/kalil0321/ats-scrapers/main/ats-companies/{greenhouse,lever,
  ashby,workable,personio,rippling,recruitee,pinpoint,teamtailor}.csv, row count minus
  header — matches docs/superpowers/reports/2026-07-17-engine-dry-run.md's live-run
  ingest counts for greenhouse/lever/ashby (9,935) exactly. -->
  jobhive ships slug CSVs for **all five** of the above unbuilt vendors, not just
  Workable — workable 4,269, personio 2,463, rippling 1,923, recruitee 888, pinpoint 350
  (~9,893 additional slugs, all MIT via jobhive) — **plus Teamtailor** (1,010 slugs, also
  MIT via jobhive, see below), taking total nominal reach to **~20.8k slugs across 9
  vendors** (the 3 shipped ATS connectors' ~9,935 plus these 6, 10,903 total).
- **Teamtailor** — public RSS at `https://{slug}.teamtailor.com/jobs.rss` (no auth); the
  REST API needs a key. EU-startup-heavy. RSS mechanics confirmed; multi-function breadth
  not (only sample was a design agency). Effort **S** if RSS suffices.
  <!-- corrected/added 2026-07-17: see reports/2026-07-17-handoff-integration.md
  (§3 item 4, Teamtailor rewrite). --> **Correction: breadth RESOLVED** — four live
  tenants (polestar/luminorbank/paysend/unobravo) show the RSS is the full public board,
  every function, with `tt:department` attached; the "only sample was a design agency"
  gap is closed. **Slug supply confirmed**: jobhive `teamtailor.csv`, **1,010 rows**
  (MIT), second-largest of the five new vendors. **Hard build requirement — per-tenant
  Content-Signal gate**: robots path rules are uniformly permissive (`/jobs.rss` never
  blocked), but the `Content-Signal` line differs per tenant — polestar declares
  `search=no, ai-train=no, ai-input=no` even though its path is open; Caliber feeds JD
  text into an LLM scoring pipeline (the `ai-input` class), so **a tenant declaring
  `ai-input=no` must be skipped**. Same posture as Recruitee's per-tenant robots gate,
  one extra field parsed (ignition plan task 4.3a, the generalized crawl-permission gate).
- **Himalayas API** — free, documented, no auth, ~108k remote jobs, explicit
  Finance/Legal/HR/Sales categories. **Gap-fill, not backbone**: no ATS/careers field,
  24h-stale, 20/page. Needs a startup filter + attribution.
- **Glints** — most favourable robots.txt of any SEA board (job pages crawlable; only
  personalized/tracking paths blocked), startup-leaning. **The legal growth path for the
  local persona**, superseding JobStreet volume growth.
- **Getro-powered VC portfolio boards** — *technically easy, but the ToS forbids it — see
  the flag below.* No usable public API (`api.getro.com/v2/networks/{id}/jobs` is gated
  behind a paid contract, 401 unauthenticated). Technically, every Getro board exposes a
  clean unauthenticated JSON route — `GET https://{board-host}/_next/data/{buildId}/jobs.json?q={term}`
  returns 200, verified live on `jobs.accel.com`, `indexventures.getro.com`,
  `community.getro.com` — and the **buildId is shared across all Getro domains**
  (`kwlUMI4kNpd4nO77X5MMC`), so one pattern reaches all 700+ networks; apply URLs resolve
  straight to the underlying ATS (`jobs.ashbyhq.com/G2/…` Accel→Ashby;
  `boards.greenhouse.io/a16z/…`). Exec titles appear in volume (live counts: Head-of 316,
  VP 182, CEO 169, COO 134, CFO 85). **BUT — the adversarial verifier fetched
  `getro.com/terms` and found a verbatim clause prohibiting anything that "crawls, scrapes,
  or spiders any page, data, or portion" of the service.** This is not "ToS unreviewed" — it
  is an *explicit, reviewed prohibition*. So Getro moves to **grey-bordering-dangerous** (§7):
  do **not** build a Getro scraper as a standing ingestion path. The defensible use, if any,
  is one-off *company-name discovery* (names are also obtainable from yc-oss/Crunchbase
  without touching Getro), then hitting each company's ATS directly. Given jobhive + yc-oss
  already supply the company list, **the marginal value of Getro no longer justifies the ToS
  exposure** — deprioritise it. Effort was **M**; the blocker is legal, not technical.

**Tier 3 — never / trap:**
- **LinkedIn / Indeed / Glassdoor** — explicit ToS+robots bans, litigated enforcement
  (hiQ: $500k consent judgment; Proxycurl, 2025: a $10M-ARR business shut down).
  Structurally no read path.
- **Wellfound** — best niche fit on paper (130k+ listings, 100% startups), worst access
  (Cloudflare + DataDome; robots blocks exactly the role-filtered views needed).
  Partnership or nothing.
- **Single-function boards** — RepVue (403s its own robots.txt), Mind the Product (**27
  live roles**), Coroflot (64), TopCSJobs, HR Chief, GoInhouse, AccountingFly, Support
  Driven, Dribbble (write-only API). **The math is unambiguous: one seeded Stripe ≈ 280
  non-eng postings; one Mind the Product connector = 27 product postings.** Adding
  companies dominates adding function boards in every case examined.
- **Exec marketplaces — none have an ingestible job object** (gap-fill confirmed the
  Toptal/MarketerHire pattern generalises): **Bolster**, **Continuum**, **On Deck Talent**
  are matching/recruiting services with no listing+apply flow. **Pallet** *shut down its
  job-board product entirely* mid-2025 (pivoted to contingency recruiting) — dead lead.
  **Chief of Staff Network** (~48 roles, not 5,000; no schema.org markup, ATS links behind
  JS) — not worth it. "Exec.com" is an unrelated AI-sales SaaS, not an exec marketplace.
- **VC-portfolio boards, both vendors** — **Getro** is technically trivial (open `_next/data`
  JSON, shared buildId across all boards) but its **ToS verbatim forbids scraping** (§4.2, §7),
  so it's out. **Consider** (a16z's primary board, Sequoia, First Round) is a technical
  dead-end anyway: client-rendered React, obfuscated `/mendel/{hash}/boards` bundle, no
  discoverable endpoint. Either way the company names are already in yc-oss/jobhive — the VC
  boards add nothing the legal-clean path doesn't.
- **Toptal / MarketerHire** — matching marketplaces, **no ingestible job object**.
- **Remotive free API** — explicit anti-aggregator ToS clause.
- **jobdataapi.com** ($295–1,650/mo, 45.5M ATS-sourced jobs) — the "buy" option. It
  proves the architecture is right (someone commoditized ATS fan-out) but sells
  *undifferentiated volume*; the curated startup list **is** the differentiation.
  Revisit only if the company-list engine fails.
- **Crunchbase** (free tier eliminated 2025), **OpenVC** (investors, not startups),
  **Indie Hackers** (too small to run an ATS), **Levels.fyi** (eng-skewed), **BuiltIn**.
- **MDEC** — downgraded to PARTIAL by a verifier: a tax-incentive registry (4,379 MY
  companies) full of MNC/BPO subsidiaries, names only, zero job/ATS data. **Cradle** —
  its one API is an orphaned WordPress endpoint with **2 records**. Manual harvesting aids only.

### 4.3 Stage 2 — The company-list engine (the centrepiece)

**Pipeline (one script + one cron):**

1. **Ingest** — vendor the three jobhive CSVs → ~9,935 `(name, slug, ats, url)` rows.
2. **Filter for niche — INVERTED PIPELINE.**
   <!-- corrected 2026-07-17: the domain-join below is impossible on the real data — see
   docs/superpowers/plans/2026-07-17-source-engine-ignition.md task 0.2 + Risks, and the
   measured breakdown in src/server/sources/nicheFilter.ts (module header). -->
   jobhive's `url` is always the **ATS board URL**, never a company domain — all 9,935
   rows normalize to just 3 vendor hosts (`job-boards.greenhouse.io` 4,966/4,966,
   `jobs.lever.co` 2,113/2,113, `jobs.ashbyhq.com` 2,856/2,856); jobhive's own
   `ats-companies/README.md` states the column is the canonical public careers URL by
   design, and there is no company-domain column and never was. A domain join against
   jobhive therefore returns **0 rows**.

   The pipeline inverts instead: the **niche lists drive**, and jobhive becomes an
   `(ats, slug)` lookup keyed off the company (normalized name / domain-stem), gated by
   mandatory identity verification (see step 3.5 below) before anything is eligible to
   seed. `companyDomain` comes from the niche lists' `website` field — the only source of
   it anywhere in the data — so both bulk-seeding and the freshness/re-detection loop
   hard-require it. **topstartups.io is dropped from this join** (and from Tier 1, §4.2) —
   it returns HTTP 403 to non-browser clients, has no API/export, and its terms are
   UNKNOWN; under this spec's own §7 posture (treat any 403 as a stop signal, never spoof
   a browser UA) it is not legitimately ingestible. Only yc-oss + remoteintech drive the
   match.

   Any startup signal survives → measured **~861 companies** (yc-oss Active 656
   candidates + remoteintech 228 candidates, deduped to 861; 11.3% of jobhive matches
   some niche list) — still a **~70× expansion** over the 12 hand-seeded sources, though
   the *validate* stage (step 3 below) has not yet run against this candidate set, so the
   seedable count will be lower.
   *Do not pre-filter for "remote-only companies"* — seed the company and let the
   existing per-posting geo filter (`config.geo` + parsed `RawPosting.geo`) decide
   visibility per posting.
3. **Validate before seeding** (non-negotiable — the Aspire 404 proves listing-page
   slugs lie): hit the real endpoint (`boards-api.greenhouse.io/v1/boards/{slug}/jobs`
   etc.), require HTTP 200, record `jobCount` + `lastValidatedAt`. Politeness ≤2–4
   concurrent per vendor host; ~5k greenhouse slugs at ~1 req/s ≈ **90 minutes, once**.
   *Trap:*
   <!-- corrected 2026-07-17: see src/server/sources/nicheFilter.ts (measured host
   distribution). --> **all** 4,966/4,966 greenhouse rows (100%) use the new
   `job-boards.greenhouse.io` host — the **API host is unaffected**, but slug-extraction
   regex must accept both hosts.
4. **Bulk-seed** `sources` rows.
5. **Freshness loop** (weekly cron) — revalidate every enabled row. On failure increment
   `consecutiveFailures`; at 3 → `status='dead'` + queue **re-detection**:
   <!-- corrected 2026-07-17: `careers_url` does not exist as specified — see
   src/server/sources/nicheList.ts + freshness.ts (module headers), and
   docs/superpowers/plans/2026-07-17-remote-source-expansion.md task 2.3 for the raw-HTML
   discovery-ceiling finding. --> **yc-oss has no careers/jobs URL field at all**
   (verified across the union of keys of all 6,050 records), and remoteintech's
   `careers_url` (69.2% populated) points directly at a greenhouse/lever/ashby board on
   only 1.7% of entries — so re-detection derives the target from `config.companyDomain`
   instead: try `https://{companyDomain}/careers`, then the bare domain root, and run the
   ATS-signature regex (`boards.greenhouse.io/([\w-]+)`, `jobs.lever.co/([\w-]+)`,
   `jobs.ashbyhq.com/([\w.-]+)`) against whichever 200s first; if the company moved
   (Lever→Ashby happens constantly) **rewrite `config` in place**. A dead slug must never
   silently 404 forever — it heals or it is visibly disabled with a count on an admin
   surface.

   **This is re-detection, not discovery.** A raw-HTML scan of 25 sampled residue
   companies (niche-list companies jobhive doesn't already match) found an ATS signature
   on **0 of 25** — client-rendered careers pages hide it (Deepnote has a live Ashby
   board at `jobs.ashbyhq.com/…` while `deepnote.com/careers` 404s). The freshness loop
   only heals companies that **already had** a detected board and moved; it does not
   surface new companies.
6. **Growth loop** — yc-oss `changes/latest.json` daily diff for new YC companies
   (website → careers scan → slug → validate); quarterly jobhive re-pull; manual SEA
   harvesting (500 Global SEA ~270–300, East Ventures 300+, MDEC filtered) into the same
   detection funnel. **This is how the local persona escapes JobStreet dependence.**

**A `sources` row after the engine:**

```json
{
  "id": "gh:vercel",
  "name": "Vercel", "kind": "ats", "persona": "remote", "enabled": true,
  "config": {
    "connector": "greenhouse", "slug": "vercel",
    "geo": { "scope": "anywhere" },
    "provenance": ["jobhive", "yc-oss"], "companyDomain": "vercel.com",
    "lastValidatedAt": "2026-07-16T02:00:00Z", "jobCount": 87,
    "consecutiveFailures": 0, "status": "active"
  }
}
```

Health fields live in `config` initially; promote `status`/`lastValidatedAt` to columns
when the admin UI needs to query them.

### 4.4 Stage 3 — Decoupling ingestion from matching

**What breaks at 1,000 sources**, from the real constants:
- **Wall-clock**: 1,000 / 8-wide ≈ 125 sequential waves ≈ **2–5 min fetching**, before
  40 deep scores × 20–60s / 3-wide ≈ **4.5–13 min scoring** → **10–20 min per scan.**
- **Politeness**: 1,000 "sources" is really ~3 vendor hosts. Per-user fan-out means
  every user's daily scan re-fetches ~1,000 boards — N users × 1,000 GETs/day,
  redundantly. Greenhouse historically doesn't rate-limit; **that is not a guarantee to burn.**
- **SQLite/libsql**: single writer, and this project's `file:` driver **forbids
  concurrent `db.transaction`**. Concurrent user scans each writing thousands of
  per-user rows is exactly the contention shape that hurts.
- **DB growth**: per-user fan-out duplicates the posting universe per user
  (`unique(userId, dedupeKey)`) — O(users × postings). ~30k live postings × users is
  pointless duplication.
- **Credits**: ~10/scan (~$0.33 at $5=150) covers ~40 deep scores fine *because* the
  two-stage gate holds. Discovery has no LLM cost — so credits are **not** the
  decoupling driver. Wall-clock, politeness, and write contention are.

**Decision: decouple.**
- A **scheduled crawler** (nightly, or 2–4×/day) fetches all enabled sources **once**,
  upserting a new global **`postings`** table (no `userId`). Global dedupe key: ATS
  `externalId` when present, else normalized company-domain + title + location bucket.
  **ATS-direct records win over aggregator (Himalayas) duplicates.**
- A **user scan** becomes: stage-1 filter over the pool (in-process, ms over ~30k rows)
  → LLM function classifier on ~200 → deep score ~40. Scan wall-clock drops to
  **scoring time only**, results are deterministic, and network cost amortizes across
  all users — the only posture defensible as a good citizen at 1,000 boards.
- **Per-user `jobs` is kept** (decision #5): it becomes the *materialized match view*.
  When a pool posting passes a user's stage-1 gate it is admitted into that user's
  `jobs` — existing `dedupeKey` normalization unchanged, `isNew`/`firstSeen` semantics
  preserved per user. The table shrinks from the universe to ~hundreds of matched rows/user.
- **Constraints**: crawler writes in **small sequential batches, no long transactions**
  (libsql); WAL + busy-timeout to interleave with user-scan writes.
- Description storage stays lazy (`describe.ts` `ensureDescription`, candidates only)
  and excerpt-bounded → pool ~100–300k rows/year with churn, comfortably SQLite-sized,
  and doubles as the copyright mitigation (§7).

**Interim ramp:** at 100–300 companies the current per-scan fan-out still works
(2–4 min). Ramp to a few hundred after the matching fix; hold the rest until decoupling lands.

## 5. Testing

- **Regression fixtures pinning the new niche** — the exact titles from §3 must MATCH:
  CEO/CFO/CTO/COO/VP-of-X/Head-of-X/Chief of Staff/Recruiter, each against its identical
  posting *and* against a plausible variant ("Head of Finance" → "Finance Lead").
  These fixtures are the guard against silently regressing to the donor's engineer bias.
- **Negative fixtures kept** — the donor's existing `roleMatch` rejections must not all
  collapse; de-biasing must not become "match everything". Pin a few true non-matches.
- **Determinism test** — shuffle candidate insertion order, assert the top-30 slice is
  byte-identical. This is the guard for the `run.ts:535` bug.
- **Company-list engine** — CSV parse, domain-join, the `job-boards.greenhouse.io` vs
  `boards.greenhouse.io` host trap, validation 200/404 handling, `consecutiveFailures`
  → `status='dead'` → re-detection rewriting `config` in place.
- **Crawler/pool** — global dedupe key collisions, ATS-beats-aggregator canonical
  resolution, batch-write behaviour under the no-concurrent-`db.transaction` constraint.
- Live-verification of any Tier 2 source is a **prerequisite to building it**, not a test.

## 6. Rollout order

1. **Matching fix** — de-biased `roleTokens`/floor + stage-1 function tagging +
   deterministic ranking before the slice + regression fixtures. **M, ~3–5 days.**
   *Nothing else ships before this.*
2. **Company-list engine v1** — jobhive ingest, domain-join filter, validation pass,
   bulk seed with provenance/health, weekly revalidation + ATS re-detection. Seed the 3
   verified SEA slugs immediately; resolve Aspire's real token. **Ramp to ~200–300
   enabled sources, hold the rest.** **M, ~3–5 days.**
3. **Decoupling** — global `postings` pool, scheduled crawler with per-vendor
   politeness, global dedupe, `jobs` re-cast as match view, `run.ts` split into crawl
   and match loops. **Then flip on the full validated list.** **L, ~1.5–2 weeks.**
4. **New connectors, in order (post-decoupling, optional reach)** — **Workable** first
   (S, verified all-function, 4,269 slugs waiting), then Personio → Teamtailor → Recruitee
   → Pinpoint (S–M, vendor-documented), then Rippling (M, N+1 descriptions, conditional
   on operator ToS acceptance).
   <!-- corrected 2026-07-17: order amended per DECISION B / D6
   (docs/superpowers/plans/2026-07-17-source-engine-ignition.md) — Teamtailor inserted
   after Personio, Rippling moved last and marked conditional; see
   reports/2026-07-17-handoff-integration.md §1. -->
   <!-- corrected/added 2026-07-17: see reports/2026-07-17-handoff-integration.md
   (§3 item 3, stale rollout line). --> **Correction: SmartRecruiters dropped (§4.2/§7),
   do not probe** — the earlier "only after a batch hit-rate check" line contradicted the
   corrected §4.2: running that check would call the very API the robots/SAP-policy
   prohibition covers, so running it would itself be the violation. Each connector rides
   the same seed/validate/crawl machinery from steps 2–3 — the connector is the only new
   code. **S–M each; sequence, don't batch.**
   *(A Getro discovery scraper was considered as a step 5 and dropped — its ToS explicitly
   forbids scraping; see §4.2 Getro and §7. yc-oss + jobhive already supply the company list.)*

## 7. Legal posture

**JobStreet, directly** — the shipped connector calls SEEK's *own* unauthenticated JSON
API with an honest self-identifying UA, capped ~90 postings/scan, and deliberately does
not touch the Cloudflare-walled SSR page. That is the most defensible form of something
**SEEK's ToS still prohibits** (export/scrape without written consent; declared
fingerprinting countermeasures; circumvention itself a violation). Under *Van Buren*'s
"gates" framing the gate is currently **up** (open endpoint, no block) — **the moment
SEEK blocks or rate-limits, continued access flips the analysis**: the block becomes the
gate. Posture: **keep it, low-volume, local-persona only; treat any 403/429 as a stop
signal, never an obstacle; never spoof a real browser UA; do not scale JobStreet volume
with this expansion.** Growth goes via Glints. The Proxycurl lesson is that enforcement
targets the *commercially successful* — risk grows with traction, so cap this dependency now.

**Ranked register:**
- **Safe** — Greenhouse/Lever/Ashby public APIs used as designed (vendor-documented for
  external consumption; residual third-party-aggregation clause **UNKNOWN**, but an
  ecosystem of identical tools exists); jobhive CSVs (MIT); yc-oss/remoteintech
  datasets; Himalayas with attribution; **storing structured facts + short excerpt +
  link-out via `applyUrl` rather than mirroring full descriptions**.
- **Grey** — Glints crawling (robots-open, ToS unverified); one-time scrapes of
  topstartups.io; per-company careers-page detection GETs (cached, low-frequency —
  uncontroversial per *Meta v. Bright Data*'s logged-out logic, but each employer's ToS is
  individually unverified); EU-domiciled **aggregator** boards (CJEU *CV-Online*:
  aggregating another aggregator's database is the exact infringement pattern — a single
  employer's own ATS feed is **not**); recruiter names/emails parsed from descriptions
  (**GDPR third-party PII — do not persist**; cheap fix at parse time).
- **Dangerous** — LinkedIn (adjudicated twice), Indeed, Glassdoor, SEEK/JobStreet *at
  meaningful volume or post-block*; **Getro board scraping** (its Terms verbatim prohibit
  crawling/scraping/spidering — verified 2026-07-16 by fetching `getro.com/terms`; the
  clean `_next/data` JSON route being open does not license use the ToS forbids);
  **SmartRecruiters** <!-- added 2026-07-17: see reports/2026-07-17-handoff-integration.md
  (§3 item 2, §7 register). --> (the same pattern with *more* signals than Getro — ToS +
  SAP API Policy §2.2.2/§3 + a targeted robots `Disallow: /`; §4.2 above); and **any
  circumvention** (fake accounts, CAPTCHA defeat, disguised UAs). Circumvention — not public
  reading — is what sank hiQ and Proxycurl.

## 8. The honest ceiling

The ceiling is **title-dependent, not uniform** — this is the load-bearing finding, now
grounded rather than inferred. The widely-repeated "70–85% of jobs are never posted" stat
is **debunked** as applied to today's market (it traces to 1980s pre-internet research);
current analysis puts genuinely-unadvertised roles under ~10% overall — **but executive and
confidential searches are explicitly named as one of the few categories that still
qualify.** So:

- **VP / Director / Head-of / Chief-of-Staff** roles post at close to normal rates and
  **already reach the ATS fan-out in volume** (Stripe live: Chief Compliance Officer, Head
  of Finance Operations, Head of Marketing Operations, 6+ exec-titled). These are *in scope
  and covered.*
- **True whole-company CEO/CFO/COO hires at VC-backed startups** are the genuine blind spot:
  multiple executive-search sources describe these as routinely filled by retained search
  with shortlists built *before* a role is open — structurally proactive and non-public by
  design. No defensible hard percentage exists (every number in circulation is either the
  debunked generic stat or firm marketing copy); the *directional* claim — CXO ≫ Head-of in
  hidden-ness — is the only one the evidence supports.

Also structurally never captured: **fractional roles** (Bolster/Continuum/Toptal/MarketerHire
are matching services with no job object — verified); **referral-only** roles; **LinkedIn-only
postings** (many startups post nowhere else — real, permanent leakage); Wellfound-exclusive
listings (130k, best fit, hard-blocked); the **Consider-vendor slice of VC portfolio boards**
(§4.2 Tier 3); non-English SEA boards; companies too small to run any ATS.

**Does this kill the niche? No.** *"If we have a résumé, the job should be visible"* is
satisfiable for the **postable** universe, which spans every function **including
Head-of/VP/Chief-of-Staff titles at funded startups** — exactly where most users with a
résumé are looking. It is **not** satisfiable for whole-company C-suite-at-seed or fractional
work. **Ship the niche; do not market CEO-search coverage.**

## 9. Reconciliation with prior specs

- `2026-07-11-caliber-standalone-design.md` §11 framed the niche as *Malaysian/SEA
  professionals seeking remote/global roles + Malaysia-local*. That is now the **local
  persona**, not the whole product. The remote persona widens to **global remote
  startups, all functions**. The wedge (fit + **legitimacy**) is unchanged and is the
  reason single-function boards stay Tier 3 — legitimacy scoring needs the ATS-direct
  `applyUrl`, which aggregators degrade.
- **Credits** (`2026-07-16-membership-credits-guardrails-design.md`): scan stays 10
  credits. Decoupling does not change debit prices — discovery has no LLM cost and moves
  to a global crawler the user does not pay for; the ~40 deep scores the 10 credits buy
  are unchanged. **The credit model is unaffected by this program.**
- **Multitenancy** (`project-multitenant-decisions`): "per-user jobs" is **kept**
  (decision #5). The global `postings` pool sits *below* it; `jobs` remains per-user.
- **libsql** (`project-sqlite-migration-shipped`): the `file:` driver's
  no-concurrent-`db.transaction` constraint binds the crawler's write shape (§4.4).

## 10. Explicitly not built (YAGNI — agreed)

- Any single-function board connector, and any exec marketplace (§4.2 Tier 3 — none
  have an ingestible job object).
- New ATS connectors (Workable et al.) **before** steps 1–3 land. They are verified and
  sequenced as step 4, but the matching fix + company engine + decoupling come first —
  the existing three connectors already reach the whole niche once pointed at more companies.
- Any VC-portfolio-board scraper: **Getro** (ToS verbatim forbids scraping — §7) and
  **Consider** (obfuscated, not cracked — §4.2 Tier 3). Company names come from
  yc-oss/jobhive instead.
- Buying jobdataapi.com or any paid feed.
- Wellfound/LinkedIn/Indeed/Glassdoor access of any kind.
- A user-facing source picker — sources stay admin-managed global reference data.
- Full job-description mirroring (excerpt + link-out only — §7).
