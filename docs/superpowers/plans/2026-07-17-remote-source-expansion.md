# Remote-Startup Niche & Source Expansion — Implementation Plan

Derived from `docs/superpowers/specs/2026-07-16-remote-startup-niche-source-expansion-design.md`
(operator-approved design, 2026-07-16). Plan written 2026-07-17.

## Context

Re-aim Caliber's niche to **global remote startups, all job functions** (SEA-local persona
retained). The design's central finding: the existing three ATS connectors
(`greenhouse`/`lever`/`ashby`) already reach every function at every company — they are just
pointed at 12 companies, and two matching bugs silently reject the new niche. So this program
is (1) fix matching, (2) grow the company list 12 → 1,500–4,000, (3) decouple global ingestion
from per-user matching, (4) add verified connectors. Sequential — **nothing ships before the
matching fix** (design §4.1, §6).

This plan makes **Phase 1 & 2 atomic and executable**; **Phase 3 & 4 are milestone-level and
require a fresh `/plan` pass before execution** (architecture decisions surface once 1–2 land).
Only Phase 1 gets an execution handoff now.

## Spec references

- Design: `docs/superpowers/specs/2026-07-16-remote-startup-niche-source-expansion-design.md`
  — §4.1 matching fix, §4.2 tiered sources, §4.3 company-list engine, §4.4 decoupling,
  §5 testing, §6 rollout order, §7 legal, §8 ceiling, §10 out-of-scope.
- Superseded niche framing: `docs/superpowers/specs/2026-07-11-caliber-standalone-design.md` §11.
- Credits (unaffected): `docs/superpowers/specs/2026-07-16-membership-credits-guardrails-design.md`.

## Gap analysis

| Area | Exists (file:line) | Needed | Delta | Risk |
|---|---|---|---|---|
| Tokenizer | `roleMatch.ts:50-57` drops words ≤3 chars; `SHORT_SPECIALTY:35` tech-only; `ROLE_STOPWORDS:20` has `head`/`chief` | Keep ≥2 chars; role-acronym allowlist; function-neutral glue words stopworded | Rewrite `roleTokens` + two token sets | **High** — must not become "match everything"; existing negative tests + all-baseline shortcut (`:90-91`) must survive |
| Single-token floor | `roleMatch.ts:95` blanket `overlap.length < 2` | ≥1 non-baseline shared token; drop ≥2 floor when sole overlap non-baseline | Rewrite floor in `titleMatchesPosting` | High — coupled to tokenizer; same fixtures |
| Ranking before slice | `run.ts:541` `pool.slice(0, TOP_N)` slices collision Map in insertion (race) order; boolean matching, no score | Deterministic sort before slice | Sort by `(postedAt desc, dedupeKey asc)` | Med — determinism regression if missed |
| Function tag | none (net-new; `RawPosting` has no `function`) | Coarse function enum from title tokens | Net-new field + deriver | Med — **deferred to Phase 3** (its only consumer, the LLM classifier, is Phase 3) |
| Company list | `seed.ts:21-51` 12 employer rows + jobstreet + manual | 1,500–4,000 validated rows | jobhive ingest → domain-join → validate → bulk-seed → freshness loop | High — slug staleness (Aspire 404), gh host trap |
| Sources repo | `repos/sources.ts` single `insert`, no health fields | Bulk insert; health in `config` json | Add `bulkInsert`; no schema migration | Low |
| Global postings pool | **does not exist** — postings transient in `run.ts:253`, upserted straight to per-user `jobs` (`unique(userId, dedupeKey)` `schema.ts:176`) | Global `postings` table, crawler, run.ts split | Net-new table + crawler + `jobs` re-cast as match view | **High** — libsql no-concurrent-`db.transaction`; L effort |
| Cheap LLM classifier | pattern exists (`correlate`/`jd-extract` in `models.yml`, `client.ts:9` TaskName, `renderTemplate` wrappers) | New `function-classify` task | Net-new task block + template + wrapper | Med — Phase 3 |
| New connectors | `FACTORIES` `connectors/index.ts:15` = gh/lever/ashby/jobstreet; `SourceConnector` iface `connector.ts:55` | Workable→Recruitee→Personio→Pinpoint→Rippling | One factory each; `discover()` + `fetchDetail?` | Med — live-verify prerequisite; Rippling N+1 |

## Tasks

Legend: `model:` fittest model · `@agent` executor · `exec:` subagent (autonomous, test-gated) or
session (needs operator in loop). Test gate per task: `npm test`. Merge gate: `npm run check`.

### Phase 1 — Matching fix (ship-gate; nothing else ships first). ~3–5 days.

- [x] **1.1 De-bias `roleMatch` (tokenizer + single-token floor) with regression fixtures.**
  Goal: résumé titles across every function (CEO/CFO/CTO/COO/VP-of-X/Head-of-X/Chief of Staff/
  Recruiter) match their identical posting and plausible variants, WITHOUT the tokenizer becoming
  "match everything".
  - In `roleMatch.ts`: (a) `roleTokens` keeps tokens length ≥2 (was `>3`); (b) add a role-acronym
    set (`ceo,cto,cfo,coo,cmo,cro,cpo,vp,gm,hr,pm,bd,ae,sdr,csm`) kept alongside `SHORT_SPECIALTY`,
    making short-token retention function-agnostic; (c) extend `ROLE_STOPWORDS` with function-
    neutral glue now admitted by the ≥2 rule (`of,the,and,for,to,in,at,on` — verify none are
    real signal); (d) in `titleMatchesPosting` (`:95-101`) replace the blanket `overlap.length < 2`
    with: require `discriminating.length ≥ 1`, and drop the ≥2 floor when the sole overlap is a
    non-baseline token; keep Jaccard ≥ 0.6.
  - **Must not break** the existing all-baseline containment shortcut (`:90-91`) or its negative
    guards, and the donor's true non-matches must still reject (design §5 "de-biasing must not
    become match-everything").
  - Test must pass: NEW positive fixtures — each §3 title MATCHES its identical posting AND a
    variant ("Head of Finance"→"Finance Lead"); NEW negative fixtures pinned (baseline-only
    collision e.g. bare "Engineer"↔"Engineer" still REJECT; a few donor rejections preserved);
    all existing `roleMatch.test.ts` blocks stay green.
  - Acceptance: `npx vitest run src/server/search/roleMatch.test.ts` green with the new fixtures;
    the §3 REJECT table now all MATCH.
  - Files: `src/server/search/roleMatch.ts`, `src/server/search/roleMatch.test.ts`.
  - `model:opus` `@general-purpose` `exec:subagent` — fuzzy balance, core-correctness. Confidence 90%.

- [x] **1.2 Deterministic ranking before the top-N slice.**
  Goal: the top-30 candidate slice is a pure function of posting content, independent of connector
  network-race / Map-insertion order.
  - In `run.ts` `scoreTopCandidates`, sort `pool` before `pool.slice(0, TOP_N_CANDIDATES)` (`:541`)
    by `(postedAt desc — nulls last, then dedupeKey asc)` as the stable tiebreak. (No `stage1Score`
    exists yet — matching is boolean; a real stage-1 score arrives in Phase 3. `postedAt`+`dedupeKey`
    is deterministic and sufficient for this bug.) Map-insertion order must never reach the slice.
  - Test must pass: determinism test (design §5) — build a candidate set, score it, then shuffle
    the collision-group / candidate insertion order and assert the top-30 slice is byte-identical.
  - Acceptance: shuffle test green; `npm test` green.
  - Files: `src/server/search/run.ts`, `src/server/search/run.test.ts`.
  - `model:sonnet` `@general-purpose` `exec:subagent`. Confidence 95%.

### Phase 2 — Company-list engine v1. Ramp to ~200–300 enabled, hold the rest. ~3–5 days.
_Execute after Phase 1 is merged and verified. Generate this phase's handoff via `/subagent-handoff` then._

- [x] **2.1 Seed the 3 live-verified SEA slugs.**
  Goal: `GoToGroup` (lever), `shopback-2` (lever), `bjakcareer` (ashby) seeded as SEA sources.
  - Add three rows to `seed.ts` `sourceSeeds` in the existing `{connector,slug,geo}` shape,
    persona per design (SEA/local-diverse). **Aspire is deliberately omitted** — its listing slug
    404s live; resolving its real token is a manual operator follow-up (noted, not in this task).
  - Test must pass: seed rows parse and insert (extend the seed test); connector resolution
    (`connectorForSource`) succeeds for each.
  - Files: `src/server/persistence/seed.ts` (+ its test).
  - `model:sonnet` `@general-purpose` `exec:subagent`. Confidence 90%.

- [x] **2.2 jobhive CSV ingest + parser (host-trap aware).**
  Goal: the three vendored jobhive CSVs parse into normalized `(name, slug, ats, url)` rows,
  accepting BOTH `boards.greenhouse.io` and `job-boards.greenhouse.io` hosts (design §4.3 trap).
  - New script/module under `src/server/sources/` (net-new dir). Vendor CSVs under a data path;
    slug-extraction regex accepts both greenhouse hosts (API host unaffected).
  - Test must pass: parse a fixture CSV containing both greenhouse hosts + lever + ashby rows →
    correct `(name, slug, ats)`; malformed rows fail loud (no silent skip of a required field).
  - Files: `src/server/sources/jobhive.ts` (+ test), fixture CSV.
  - `model:sonnet` `@general-purpose` `exec:subagent`. Confidence 85%.

- [ ] **2.3 Niche filter — INVERTED PIPELINE (rewrite in flight 2026-07-17).**
  Original "domain-join" design was WRONG: jobhive's `url` is always the ATS board URL (100% of 9,935
  rows resolve to 3 vendor hosts; jobhive's README states the column is the careers URL by design and
  there is no company-domain column) → 0 joins. Resolved by live data probe → **Option D: the niche
  lists drive, jobhive becomes an `(ats, slug)` lookup** keyed by normalized name / domain-stem.
  - `nicheList.ts` (net-new): parse yc-oss `all.json` (6,050 recs; `website` 99.4%; **no careers field
    exists**) + remoteintech `src/companies/*.md` frontmatter (883 files; `website` 99.8%,
    `careers_url` 69.2% but only 1.7% ATS-direct; licence **ISC**, not NOASSERTION).
  - `nicheFilter.ts`: rewrite to `matchNicheToJobhive` → `EngineCandidate{name,slug,ats,companyDomain,
    provenance[],matchMethod}`. Iterated suffix stripping required ("Canary Technologies" vs
    "Canary Technologies Corp").
  - `identity.ts` (net-new): mis-attribution guard — name-matching provably mis-attributes
    (jobhive "Affinity.co" ↔ YC "Affinity"/`itsaffinity.com` are DIFFERENT companies;
    `jobs.lever.co/porter` = "Porter Cares, Inc.", not porter.run). Greenhouse exposes
    `/v1/boards/{slug}` → `{"name":...}`; ashby/lever expose no org identity → `unverifiable`.
  - **`companyDomain` source = niche-list `website`** — the only one in the data; closes seedFromEngine's gap.
  - **Measured yield ~1,000–1,100 companies, NOT the design's 1,500–4,000** (11.3% of jobhive matches).
  - **topstartups.io DROPPED** — 403 to non-browser clients, no API/export, terms UNKNOWN (§7 stop signal).
  - Careers-scan fallback is marginal (0/25 residue companies exposed an ATS signature in raw HTML;
    client-rendered sites hide it — Deepnote has a live Ashby board while `deepnote.com/careers` 404s).
    `redetect` stays a re-detection tool; it is NOT a discovery engine.
  Goal: jobhive rows joined against yc-oss + remoteintech + topstartups on **normalized domain**
  (never company name) yield the niche subset (expect 1,500–4,000). Do NOT pre-filter remote-only.
  - Domain normalization (strip scheme/`www`/path, lowercase). Join key = domain only.
  - Test must pass: domain normalization cases; join matches on domain despite differing names;
    a name-only "match" does NOT join.
  - Files: `src/server/sources/nicheFilter.ts` (+ test).
  - `model:sonnet` `@general-purpose` `exec:subagent`. Confidence 85%.

- [x] **2.4 Endpoint validation logic (200/404, jobCount, per-host politeness).**
  Goal: candidate slugs are validated against their real ATS endpoint; only HTTP 200 (recording
  `jobCount` + `lastValidatedAt`) is eligible to seed; concurrency capped ≤2–4 per vendor host.
  - Validation function takes an injected `fetch` (test double). The 90-min live run over ~5k
    slugs is an OPERATOR step, not a test.
  - Test must pass: 200 → `{ok, jobCount, lastValidatedAt}`; 404 → not-ok; per-host concurrency
    cap respected (mocked fetch counting in-flight); greenhouse both-hosts accepted.
  - Files: `src/server/sources/validate.ts` (+ test).
  - `model:sonnet` `@general-purpose` `exec:subagent`. Confidence 85%.

- [x] **2.5 Bulk-seed sources with provenance/health config.**
  Goal: validated rows bulk-insert as `sources` with health/provenance in `config` json
  (`provenance[]`, `companyDomain`, `lastValidatedAt`, `jobCount`, `consecutiveFailures`, `status`)
  — no schema migration (design §4.3: promote to columns only when admin UI needs it).
  - Add `bulkInsert(rows)` to `repos/sources.ts` (mirror single `insert`, `onConflictDoNothing`).
  - Test must pass: bulk insert round-trips the config shape; conflict on existing `id` is a no-op;
    `listEnabledByPersona` returns the seeded rows.
  - Files: `src/server/persistence/repos/sources.ts` (+ test), `src/server/sources/seedFromEngine.ts`.
  - `model:sonnet` `@general-purpose` `exec:subagent`. Confidence 85%.

- [x] **2.6 Freshness + ATS re-detection loop.**
  Goal: a revalidation pass increments `consecutiveFailures`; at 3 flips `status='dead'` and
  re-detects — fetch the company `careers_url`, run ATS-signature regexes
  (`boards.greenhouse.io/([\w-]+)`, `jobs.lever.co/([\w-]+)`, `jobs.ashbyhq.com/([\w.-]+)`), and if
  the company moved ATS, **rewrite `config.connector`/`config.slug` in place**. A dead slug heals or
  is visibly disabled — never silently 404s forever.
  - Loop function is the testable unit; the weekly cron wiring is operational (note, not code here).
  - Test must pass: 200 resets `consecutiveFailures`; 404×3 → `status='dead'` → re-detection rewrites
    `config` when the signature regex finds a new ATS; the three regexes extract correctly.
  - Files: `src/server/sources/freshness.ts` (+ test).
  - `model:opus` `@general-purpose` `exec:subagent` — config-rewrite + regex subtlety. Confidence 80%.

_Deferred within Phase 2 (operational, exec:session, not atomic): the growth loop — yc-oss
`changes/latest.json` daily diff, quarterly jobhive re-pull, manual SEA harvesting into the
detection funnel (design §4.3.6)._

### Phase 3 — Decoupling ingestion from matching. **Milestones — re-`/plan` before executing.** ~1.5–2 weeks.
_Global crawler + shared pool. Architecture decisions (dedupe canonicalization, crawler scheduling,
libsql write-batching) will refine during a dedicated plan pass. Confidence <70% at task grain today._

- [ ] **M3.1 Global `postings` table** (net-new, no `userId`; global dedupe key = ATS `externalId`
  else normalized-domain+title+location-bucket). Schema migration. `model:opus` `@general-purpose` `exec:session`.
- [ ] **M3.2 Scheduled crawler** — fetch all enabled sources once (nightly / 2–4×/day), upsert
  `postings` in **small sequential batches, no long transactions** (libsql `file:` forbids concurrent
  `db.transaction`), WAL + busy-timeout, per-vendor-host politeness. `model:opus` `exec:session`.
- [ ] **M3.3 Global dedupe + canonical resolution** — ATS-direct beats aggregator (Himalayas)
  duplicates. `model:opus` `exec:session`.
- [ ] **M3.4 Coarse function tag + cheap LLM function classifier** — net-new `function` field derived
  from title tokens (the Phase-1 deferral lands here, where its consumer exists); new
  `function-classify` task (`client.ts` TaskName + `models.yml` block + `renderTemplate` wrapper,
  mirroring `correlate`) resolving ambiguous ~200 survivors. `model:sonnet` `exec:session`.
- [ ] **M3.5 Split `run.ts` into crawl + match loops** — user scan becomes stage-1 filter over the
  pool → classifier on ~200 → deep score ~40. `jobs` re-cast as the per-user **materialized match
  view** (pool posting passing a user's stage-1 gate is admitted into that user's `jobs`;
  `isNew`/`firstSeen`/`dedupeKey` semantics preserved). Then flip on the full validated list.
  `model:opus` `exec:session`.

### Phase 4 — New connectors (post-decoupling, optional reach). **Milestones — sequence, don't batch.** S–M each.
_Each: live-verify the endpoint FIRST (design §5 "prerequisite to building, not a test", exec:session),
then build one factory (`discover()` + `fetchDetail?`) registered in `connectors/index.ts` FACTORIES,
riding the existing seed/validate/crawl machinery. Build order is verified priority._

- [ ] **M4.1 Workable** — `apply.workable.com/api/v1/widget/accounts/{slug}` (`?details=true`), no auth,
  distinct `function` field, ~4,269 slugs waiting. `model:sonnet` `@general-purpose` `exec:session`.
- [ ] **M4.2 Recruitee** — `{slug}.recruitee.com/api/offers/`, no auth. `model:sonnet` `exec:session`.
- [ ] **M4.3 Personio** — `{slug}.jobs.personio.com/xml?language=en`, **XML** (parser cost), remote in
  office string. `model:sonnet` `exec:session`.
- [ ] **M4.4 Pinpoint** — `{slug}.pinpointhq.com/postings.json`, no auth. `model:sonnet` `exec:session`.
- [ ] **M4.5 Rippling** — `ats.rippling.com/api/v2/board/{slug}/jobs`, undocumented, **N+1** detail
  calls (`fetchDetail` per posting). `model:sonnet` `exec:session`.
- [ ] **M4.6 SmartRecruiters** — ONLY after a 20–30-slug batch hit-rate check (5/7 returned zero live;
  `robots.txt Disallow: /`). Gated. `model:sonnet` `exec:session`.

## Risks & uncertainties

- **1.1 over-matching**: lowering to ≥2 chars admits glue words; the stopword extension is the
  guard. The negative fixtures (design §5) are the only defense against silently regressing to
  "match everything" — they are mandatory, not optional.
- **Aspire-class slug staleness**: listing-page slugs lie; task 2.4 validation is non-negotiable
  before any bulk seed (design §4.3.3).
- **Greenhouse host trap** (`job-boards` vs `boards`): API host unaffected but slug regex must
  accept both — pinned in 2.2 and 2.6 tests.
- **libsql single-writer / no concurrent `db.transaction`** (`project-sqlite-migration-shipped`):
  binds the crawler write shape in M3.2 — the reason Phase 3 is a re-plan, not a straight build.
- **Phase 3/4 grain**: written as milestones deliberately; forcing them atomic today would be
  speculative (CLAUDE.md simplicity). Re-`/plan` each before execution.
- **Legal (design §7)**: JobStreet kept capped/local-only, any 403/429 is a stop signal; **Getro is
  out** (ToS verbatim forbids scraping); no circumvention. These are constraints on Phase 4 choices.

## Out of scope (design §10 — YAGNI, agreed)

- Any single-function board connector; any exec marketplace (no ingestible job object).
- Any VC-portfolio-board scraper — **Getro** (ToS forbids) and **Consider** (obfuscated).
- New connectors (Workable et al.) **before** Phases 1–3 land.
- Buying jobdataapi.com or any paid feed; Wellfound/LinkedIn/Indeed/Glassdoor access of any kind.
- A user-facing source picker (sources stay admin-managed global reference data).
- Full job-description mirroring (excerpt + link-out only — design §7 copyright mitigation).
- Marketing CEO-search coverage (design §8 — whole-company C-suite-at-seed is a real blind spot).

## Models & execution

- `model:` — `opus` = fuzzy judgment / core-correctness / architecture; `sonnet` = default build.
- `@agent` — `general-purpose` (has full tool access) executes build tasks.
- `exec:` — `subagent` = autonomous, test-gated, run from the handoff via `/continue-handoff`;
  `session` = needs the operator in the loop (live verification / architecture judgment).
- Per-task gate: `npm test` (Vitest `vitest run`). Targeted: `npx vitest run src/server/search/`.
- Merge gate: `npm run check` (`typecheck && vitest run && contract:check && build`).
- **Handoff scope: Phase 1 only** (2 tasks). Phase 2 handoff via `/subagent-handoff` after Phase 1
  merges; Phase 3 & 4 require a fresh `/plan` pass first.
