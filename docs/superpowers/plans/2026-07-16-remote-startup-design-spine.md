# Design Spine — Remote-Startup Niche & Source Expansion (cross-wave contract)

**Status:** authoritative cross-wave interface contract for the 4-wave implementation plan.
Every wave plan MUST honor the shapes named here so the plans stay type-consistent across
waves. Derived from `docs/superpowers/specs/2026-07-16-remote-startup-niche-source-expansion-design.md`
(the spec — the single source of truth for WHAT) + a code fact-extraction pass 2026-07-16.

This spine resolves design decisions the spec under-specifies. Where it refines the spec,
the refinement is marked **[REFINEMENT]** with rationale — those are the flagged calls.

---

## 0. Global constraints (apply to every wave)

- **Layering:** UI → `features/*` → `server/*`. Only `server/*` touches DB or LLM.
- **Fail loud** (CLAUDE.md): validate at boundaries with `Schema.parse`; no fallback
  `0`/`""`/`unknown`. An explicit modeled category (e.g. `JobFunction = "other"`) is NOT a
  fallback — it is a real class; document it as such where used.
- **Contract = Zod in `src/types`.** Changing the WIRE `Job`/entity shapes requires updating
  the Zod contract → OpenAPI → docs. Internal DB-only fields (not sent to the client) do NOT
  touch the wire contract.
- **libsql `file:` driver FORBIDS concurrent `db.transaction`** — binds Wave 3's crawler
  write shape (small sequential batches, WAL + busy-timeout; no long/concurrent transactions).
- **Commit hook runs `tsc` from the SESSION cwd (main checkout), not a worktree** — if built
  in worktrees, keep the MAIN checkout's types green or commits gate on the wrong tree.
- **Migrations:** current latest = `drizzle/0001_goofy_bishop.sql` (the SQLite fresh-start
  rebuild reset the sequence). New migrations start at `0002_*`. **Generate with
  `npm run db:generate` (drizzle-kit) after editing `schema.ts` — never hand-author SQL.**
  Apply to the dev DB with an inline URL: `DATABASE_URL=file:./<devdb> npm run db:migrate`
  (`db:migrate`/drizzle.config load `.env.local`, which is absent in dev, so the dev DB
  silently lags migrations otherwise — the known `db-migrate-drift` gotcha).
- **Tests:** `npx vitest run <path>`. Fixtures colocated as `.test.ts`. Full suite ~1300+
  green on main — keep it green.
- **Runtime proof:** the `/verify` skill boots the app with LLM test-doubles and drives the
  paste/queue/worker/scan flows. Gate each wave on real evidence, not just tests.

---

## 1. Verified current shapes (ground truth — do not contradict)

**`sources` table** (`schema.ts:84`):
```ts
sqliteTable("sources", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["ats", "board", "manual"] }).notNull(),
  persona: text("persona", { enum: ["remote", "local", "both"] }).notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  config: text("config", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});
```
Sources are **GLOBAL admin-managed reference data — no `userId`** (`repos/sources.ts` documents this). Do not add a user dimension.

**`jobs` table** (`schema.ts:143`) — per-user (`unique(userId, dedupeKey)`), columns:
`id, userId, dedupeKey, url, applyUrl, sourceId, externalId, title, company, location,
salaryRaw, description, postedAt, firstSeenAt, lastSeenAt, persona(remote|local|pasted),
eligibility(anywhere|eligible|local|abroad|unknown), eligibilityEvidence, aliases(json),
raw(json), tzBand(apac|emea|americas)?, hiringStructure(local-entity|eor|contractor)?`.
`isNew` is computed at read time (NOT a column).

**`JobRow` = `typeof jobs.$inferSelect`**; `NewJob = typeof jobs.$inferInsert`.
**`jobsRepo.upsertByDedupeKey(row: NewJob): Promise<JobRow>`** — merges aliases, ON CONFLICT
updates `lastSeenAt`+`aliases` only.

**`sourcesRepo`** (`repos/sources.ts`): `insert(row: NewSource)`, `getById(id)`,
`listEnabledByPersona(persona)`, `listAll()`, `setEnabled(id, enabled)`.

**`seedSources(db)`** — `db.insert(sources).values(sourceSeeds).onConflictDoNothing().returning()`
(idempotent). 12 seed rows in `sourceSeeds` (`seed.ts:21`).

**Wire `Job` Zod** (`src/types/index.ts:108`): the assembled/scored client shape
(`id, score, ghost?, role, company, meta, verdict, why, tags, breakdown, fit, gaps,
legitimacy, eligibility, applyUrl, source, persona, firstSeen, isNew`). **No `function` field.**
Enum idiom: `export const Persona = z.enum(["remote","local","pasted"]); export type Persona = z.infer<typeof Persona>;`

**Connector registry** (`connectors/index.ts`):
```ts
const FACTORIES: Record<string, (source: SourceRow) => SourceConnector> = {
  greenhouse: createGreenhouseConnector, lever: createLeverConnector,
  ashby: createAshbyConnector, jobstreet: createJobstreetConnector,
};
// key = source.config.connector ?? source.id
```
**`SourceConnector`** (`connector.ts:55`): `{ id, kind:'ats'|'board'|'manual', persona,
discover(ctx)→AsyncIterable<RawPosting>, fetchDetail?, extractQuestions? }`.
**`RawPosting`** (`connector.ts:17`): `{ sourceId, externalId?, url, title, company,
location?, geo?, description?, postedAt?, salaryRaw? }`.
**`RoleTarget`** (`connector.ts:10`): `{ titles:string[], keywords:string[],
locationsPreferred?, persona }`.

**Greenhouse connector template** (`greenhouse.ts` discover()): single
`fetchJson('https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true',
{signal, redirect:'error'})`, no pagination, maps `j.id→externalId, j.absolute_url→url,
j.title→title, slug→company, j.location?.name→location, htmlToText(j.content).slice(0,40_000)
→description, j.first_published→postedAt`. Mirror this for new connectors.

**`ensureDescription(job: JobRow, source: SourceRow): Promise<JobRow>`** (`describe.ts`) —
lazy: fetches via `connector.fetchDetail` only if DB description empty, persists.

**`config/models.yml`** — `tasks.<name>: { model, maxTokens, temperature, reasoningEffort?,
strict? }` + a `prices` map. Cheap default model: `openai/gpt-oss-120b`.

**Scan pipeline in `run.ts`** (constants `TOP_N_CANDIDATES=30`@:33, `SCORE_CONCURRENCY=3`@:34,
`DEFAULT_CONCURRENCY=8`@:61):
- `:308` gate: `if (source.kind === "board" || targets.some(t => roleFuzzyMatch(t, posting)))`
  → push to `matchedPostings`.
- `:335` `upsertMatchedPostings(...)` → `groupByCollision` (Map, **insertion order**) →
  upsert canonical rows → returns `{job: JobRow, source: SourceRow}[]` in Map-iteration
  (= network-race) order.
- `:514` `scoreTopCandidates(candidates)` → `pool = candidates.filter(...)` →
  **`:535 pool.slice(0, TOP_N_CANDIDATES)`** ← the non-determinism bug (slices race order).

---

## 2. WAVE 1 — Matching fix (contract)

Goal: the whole niche's résumés (exec/ops/finance/legal/etc.) match their postings; the
top-N slice is deterministic. Ships the existing niche correctly. **Nothing else ships first.**

### 2.1 `JobFunction` type (new)
```ts
export type JobFunction =
  | "eng" | "product" | "design" | "ops" | "finance" | "legal"
  | "marketing" | "sales" | "people" | "cs" | "exec" | "other";
```
`"other"` is an explicit modeled bucket for genuinely-unclassifiable titles, NOT a fail-loud
violation (this is a best-effort search-input classifier, like `deriveRoleTargets`, not a
wire boundary). Define alongside the classifier.

### 2.2 `classifyFunction(title: string): JobFunction` (new, pure, deterministic)
Coarse function from title tokens via a keyword→function map. Must correctly bucket the §3
exec titles (CEO/CFO/COO/VP/Head-of/Chief-of-Staff → `exec`) and common function words
(finance/controller/accounting/fp&a→finance; legal/counsel/paralegal→legal;
recruiter/talent/people/hr→people; sales/account executive/sdr→sales;
marketing/growth/brand→marketing; support/customer success/csm→cs; ops/operations→ops;
product/pm→product; design/ux/ui→design; engineer/developer/data/sre→eng). Unknown→`other`.
Live in `src/server/search/functionTag.ts` (new) or `roleMatch.ts`.

### 2.3 Exact-title-equality pre-check **[REFINEMENT — not a spec-named mechanism]**
The spec's two named mechanisms (de-bias tokens + drop floor) provably CANNOT match
"Chief of Staff" (both `chief`+`staff` are `ROLE_STOPWORDS` → tokens `[]`) or "CEO"/"COO"
(length filter → `[]`) against their identical postings. Add a normalized exact-title match:
```ts
function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}
```
In `roleFuzzyMatch`, **before tokenization**, short-circuit `true` on an identical normalized
title — via a shared helper `isExactTitleMatch(title, normalizedPostingTitle)`:
```ts
function isExactTitleMatch(title: string, normalizedPostingTitle: string): boolean {
  if (normalizeTitle(title) !== normalizedPostingTitle) return false;
  const toks = roleTokens(title);
  return toks.length === 0 || toks.some((t) => !BASELINE_TOKENS.has(t)); // NOT purely baseline
}
```
**Scope [corrected 2026-07-17 after a blocked implementer surfaced it]:** the short-circuit
fires UNLESS the title is entirely baseline tokens ("Engineer", "Manager"). A purely-baseline
one-word title stays on the baseline-rejection path — `roleMatch.test.ts` pins
`roleFuzzyMatch(["Engineer"], "Engineer") === false`, and spec §5 keeps such negatives; an
unconditional short-circuit wrongly flipped it to `true` (= "match-everything," the exact thing
§5 forbids). Titles that tokenize to empty (CEO, Chief of Staff) or carry a non-baseline token
(Head of Finance, VP of Marketing, Recruiter) are specific enough that an exact match is real.
`roleMatchScore` (§2.6) reuses the same helper for its exact-title → 1000 branch.

### 2.4 De-bias `roleTokens` **[REFINEMENT — allowlist, not the spec's "≥2 chars"]**
Keep the length floor; add a role-acronym allowlist rather than lowering to ≥2 chars.
```ts
const ROLE_ACRONYMS = new Set(["ceo","cto","cfo","coo","cmo","cro","cpo","vp","gm","hr","pm","bd","ae","sdr","csm"]);
// roleTokens filter becomes:
(w) => (w.length > 3 || SHORT_SPECIALTY.has(w) || ROLE_ACRONYMS.has(w)) && !ROLE_STOPWORDS.has(w)
```
Rationale: the spec said "keep tokens ≥2 chars," but that newly admits a whole class of glue
words (`of, in, to, an, at, on, as, by, or, the, and, for`) the current length floor
suppresses — introducing noise. The acronym allowlist keeps the floor's noise-suppression and
adds exactly the role acronyms. (`fp&a` cannot survive tokenization — `&` is stripped to a
space → `fp`,`a` — so it is not includable as one token; omit it. Document this.)

### 2.5 Drop the `overlap.length < 2` floor
Remove the standalone `if (overlap.length < 2) return false;` gate. The existing
`discriminating.length === 0` check already rejects all-baseline single-token collisions
(e.g. shared `["engineer"]`), so a single **non-baseline** overlap (`finance`, `recruiter`)
is now allowed to proceed to the Jaccard ≥ 0.6 test. Keep the `allBaseline` containment
shortcut and the Jaccard test unchanged. Preserve `postingTokens.length === 0` /
`titleTokens.length === 0` early returns (after the 2.3 exact-title check).
**Known ceiling (document, don't fix here):** single-token targets vs verbose postings still
fail Jaccard (`["finance"]` vs `["finance","operations","manager"]` = 1/3 < 0.6). Broader
recall is Wave 3's LLM classifier job. §5's required variants (`Head of Finance`→`Finance Lead`,
both `["finance"]`, 1/1=1) pass.

### 2.6 `stage1Score` + deterministic ranking (the `:535` bug)
Add **`roleMatchScore(target: RoleTarget, posting: RawPosting): number`** (deterministic):
- exact-title match → `1000` (identicals rank first).
- else best over `target.titles` of `discriminating.length * 10 + round(jaccard * 10)`.
- no match → `0`.
Thread it through the pipeline so ranking never depends on Map insertion order:
- `:308` gate: compute `stage1Score` for every matched posting (board + ATS alike, uniform
  function) → `matchedPostings: { posting, source, stage1Score }[]`.
- `groupByCollision` / `CanonicalGroup`: carry the canonical's `stage1Score` (on collision,
  keep the max).
- `upsertMatchedPostings` returns `{ job: JobRow, source: SourceRow, stage1Score: number }[]`.
- `scoreTopCandidates`: **sort `pool` by `(stage1Score desc, postedAt desc, dedupeKey asc)`
  before `.slice(0, TOP_N_CANDIDATES)`.** `postedAt` nulls sort last; `dedupeKey` is the
  stable final tiebreaker.

### 2.7 Function tag storage
Add a nullable **`function` column** to `jobs` (`text("function", { enum: <JobFunction minus
'other'? no — include all 12> })` — use the full enum). Stamp `classifyFunction(title)` at
`upsertMatchedPostings` insert. Migration `0002_*` via `db:generate`. **Do NOT add `function`
to the wire `Job` Zod contract in Wave 1** — no client consumer exists yet; the column exists
so Wave 3's LLM classifier has a target to refine and for observability. (If drafter finds a
UI facet requirement in the spec, revisit — none exists.)

### 2.8 Wave 1 tests (TDD-first)
- Regression fixtures: every §3 title MATCHES its identical posting (CEO, CFO, CTO, COO,
  VP of Marketing, Head of Finance, Head of Operations, Chief of Staff, Recruiter) AND a
  plausible variant that shares a discriminating token (`Head of Finance`→`Finance Lead`;
  `VP of Marketing`→`Marketing VP`; `Recruiter`→`Senior Recruiter`). Do NOT require
  acronym-expansion variants (`CFO`→`Chief Financial Officer`) — out of scope (no synonym map).
- Negative fixtures kept: pin true non-matches so de-biasing ≠ "match everything"
  (`Software Engineer`↛`Sales Engineer` via baseline-only overlap; a cross-function reject).
- `classifyFunction` unit tests: each function bucket + `other`.
- **Determinism test:** build a candidate set, shuffle insertion order, assert the top-30
  slice is identical (by `dedupeKey`/`id`). Guards `:535`.

---

## 3. WAVE 2 — Company-list engine (contract)

Goal: 12 → ~1,500–4,000 verified sources via MIT datasets + existing connectors; validate
before seeding; self-heal. Ramp to ~200–300 enabled, HOLD the rest until Wave 3.

### 3.1 `SourceConfig` Zod schema (new — fail-loud boundary for `config`)
```ts
// base (all sources) + health (engine-written). Health optional for legacy/seed rows.
SourceConfig = z.object({
  connector: z.string(), slug: z.string().optional(), // manual/board differ
  geo: z.object({ scope: z.string(), regions: z.array(z.string()).optional() }).optional(),
  // board configs carry other keys (api, siteKey, query…) — keep permissive via .passthrough()
  provenance: z.array(z.string()).optional(),
  companyDomain: z.string().optional(),
  lastValidatedAt: z.string().datetime().optional(),
  jobCount: z.number().int().nonnegative().optional(),
  consecutiveFailures: z.number().int().nonnegative().optional(),
  status: z.enum(["active", "dead"]).optional(),
}).passthrough();
```
Parse where the engine reads config. Health fields stay in the JSON `config` blob (spec §4.3
"Health fields live in config initially; promote to columns when the admin UI must query").

### 3.2 jobhive ingest
Vendor 3 CSVs → `data/jobhive/greenhouse.csv|ashby.csv|lever.csv` (schema `name,slug,url`).
~9,935 rows. **Host trap:** slug-extraction regex must accept BOTH `boards.greenhouse.io` and
`job-boards.greenhouse.io` (4,848/4,966 use the new host); the API host
`boards-api.greenhouse.io` is unaffected. Lever `jobs.lever.co/{slug}`, Ashby
`jobs.ashbyhq.com/{slug}`.

### 3.3 Domain-join niche filter
Normalize domains (strip scheme/`www.`/path, lowercase) and JOIN jobhive `url`-domain against
yc-oss `website`, remoteintech `website`, topstartups.io — **on domain, never name.** Any
startup signal survives → ~1,500–4,000. Do NOT pre-filter "remote-only"; let the per-posting
geo filter decide visibility.

### 3.4 Validation before seeding (non-negotiable — Aspire 404 proves slugs lie)
Hit the real endpoint per connector, require HTTP 200, record `jobCount` + `lastValidatedAt`
in config. Politeness ≤2–4 concurrent per vendor host (pLimit). ~5k greenhouse @ ~1 req/s ≈
90 min, once.

### 3.5 Bulk seed + SEA seeds
Bulk-insert `sources` rows with provenance/health config. Seed 3 live-verified SEA slugs
immediately: `GoToGroup` (lever), `shopback-2` (lever), `bjakcareer` (ashby). **Resolve
Aspire's real token first (NOT `aspire` — 404s).** Ramp enabled to ~200–300; hold the rest
(`enabled:false`).

### 3.6 Freshness + re-detection loop (weekly cron)
Revalidate every enabled row. On failure `consecutiveFailures++`; at 3 → `status:"dead"` +
queue re-detection: fetch the company's `careers_url`, run ATS-signature regex
(`boards.greenhouse.io/([\w-]+)`, `jobs.lever.co/([\w-]+)`, `jobs.ashbyhq.com/([\w.-]+)`); if
moved (Lever→Ashby is common) **rewrite `config` in place**. Surface dead-count on an admin view.
A dead slug never silently 404s forever — it heals or is visibly disabled with a count.

**Wave 2 drafter must READ FIRST:** the existing cron/scheduled-task and one-off-script
patterns (look for `scripts/`, any cron infra, admin routes) — the spine does not fix the
script/cron host; follow the repo's existing pattern.

---

## 4. WAVE 3 — Decoupling ingestion from matching (contract). Biggest change; touches LIVE deploy.

Goal: a global crawler fills a shared `postings` pool once; user scans read the pool
in-process (deterministic, fast, amortized network). Per-user `jobs` KEPT, re-cast as the
materialized match view.

### 4.1 `postings` table (new — GLOBAL, no `userId`)
Mirror `jobs`' shared fields minus the user dimension, plus the coarse+refined `function`:
```ts
sqliteTable("postings", {
  id, dedupeKey (GLOBAL), url, applyUrl?, sourceId→sources.id, externalId?, title, company,
  location, salaryRaw?, description?, postedAt?, function (JobFunction), firstSeenAt, lastSeenAt,
  tzBand?, raw(json),
}, unique("postings_dedupe_key_unique").on(dedupeKey))
```
**Global dedupe key:** ATS `externalId` when present, else normalized company-domain + title +
location bucket. **ATS-direct beats aggregator** (Himalayas) on collision — reuse
`resolveCanonicalCollision` semantics. Migration via `db:generate`.

### 4.2 Scheduled crawler (`src/server/search/crawl.ts` or similar)
Fetches ALL enabled sources once (nightly / 2–4×/day), upserts `postings`. **Writes in SMALL
SEQUENTIAL BATCHES — no long or concurrent `db.transaction`** (libsql `file:` constraint).
Enable WAL + busy-timeout to interleave with user-scan writes. Per-vendor politeness
(concurrency cap per host). Description storage stays lazy (`ensureDescription`),
excerpt-bounded.

### 4.3 User scan re-cast (split `run.ts`)
Split `run.ts` into a **crawl loop** (populates `postings`) and a **match loop**:
stage-1 filter over the pool (in-process, ms over ~30k rows) → **LLM function classifier on
~200 survivors** → deep `scoreMatch` on ~40. Admitted pool postings are materialized into the
user's `jobs` via `upsertByDedupeKey` (unchanged); `isNew`/`firstSeen` preserved per user.
`jobs` shrinks from the universe to ~hundreds of matched rows/user.

### 4.4 LLM function classifier (DEFERRED FROM WAVE 1 — operator decision)
New `config/models.yml` task `function-classify` (`openai/gpt-oss-120b`, `strict:true`,
`temperature:0.1`, small `maxTokens`). New module `src/server/search/functionClassify.ts`.
Runs only on the ~200 stage-1 survivors whose `classifyFunction` (deterministic, from Wave 1)
returned `other` or ambiguous. Refines and persists `postings.function`. **Only meaningful at
pool scale — hence Wave 3, not Wave 1.**

### 4.5 Rollout guard
Interim ramp: at 100–300 companies the current per-scan fan-out still works. Only flip on the
FULL validated list AFTER decoupling lands.

---

## 5. WAVE 4 — New ATS connectors (contract). Post-decoupling, optional reach. SEQUENCE, don't batch.

Order: **Workable → Recruitee → Personio → Pinpoint → Rippling.** SmartRecruiters ONLY after a
20–30-slug hit-rate check (5/7 tested returned zero; robots `Disallow:/` except LinkedInBot).
**Getro (ToS forbids scraping) and Consider (obfuscated) are NOT built** — company names come
from yc-oss/jobhive.

### 5.1 Connector factory pattern (every connector)
New `src/server/search/connectors/<name>.ts` exporting
`create<Name>Connector(source: SourceRow): SourceConnector`; import + register in
`connectors/index.ts` `FACTORIES` under the `config.connector` key. Mirror `greenhouse.ts`
structure (`fetchJson`, map → `RawPosting`, `yield`, `onProgress`). Honest self-identifying UA
(mirror `jobstreet.ts` posture). Excerpt-only descriptions, link-out via `applyUrl`. **GDPR:
do NOT persist recruiter names/emails parsed from descriptions** (strip at parse time).
**Live-verification of the source is a PREREQUISITE to building each connector, not a test** —
the drafter marks it as a manual pre-task gate per connector.

### 5.2 Workable (build FIRST)
`GET https://apply.workable.com/api/v1/widget/accounts/{slug}` (`?details=true` for full HTML
description), no auth, robots fully open, vendor-documented. Payload: `function` field +
`department`, `telecommuting` (bool), `locations[]`, `application_url`, `shortcode`, description.
No pagination (full list in one call). Map `shortcode→externalId`, `application_url→url/applyUrl`,
`function`→seed the coarse `JobFunction`, `telecommuting`→geo. ~4,269 slugs already in jobhive.

### 5.3 Remaining (specify each from spec §4.2 Tier 2 when built)
Recruitee `GET {slug}.recruitee.com/api/offers/`; Personio `GET {slug}.jobs.personio.com/xml?language=en`
(XML, not JSON); Pinpoint `GET {slug}.pinpointhq.com/postings.json`; Rippling
`GET ats.rippling.com/api/v2/board/{slug}/jobs` (+ N+1 `/jobs/{id}` for descriptions →
`fetchDetail`). Each rides Wave 2/3 seed/validate/crawl machinery; the connector is the only
new code.

---

## 6. Plan file paths (outputs)
- `docs/superpowers/plans/2026-07-16-remote-startup-wave-1-matching-fix.md`
- `docs/superpowers/plans/2026-07-16-remote-startup-wave-2-company-list-engine.md`
- `docs/superpowers/plans/2026-07-16-remote-startup-wave-3-decoupling.md`
- `docs/superpowers/plans/2026-07-16-remote-startup-wave-4-connectors.md`

---

## 7. Open program decisions (post-review, 2026-07-16 — awaiting operator)

These surfaced during the plan review. Waves 1/3/4 do NOT depend on them (Wave 1 is
pure matching; Wave 3/4 carry fallbacks). Only Wave 2's **real-data run** is gated by #1.

1. **`companyDomain` provenance / domain-join (BLOCKS Wave 2 real-data run). RESOLUTION
   ACCEPTED by operator 2026-07-17 — governs Wave 2 (fold into wave-2 Task 3/5 wiring when it
   becomes active).** Spec §4.3's "join jobhive `url`-domain against yc-oss/remoteintech
   `website`" is infeasible as written: jobhive's `url` is the *ATS board* host
   (`jobs.lever.co/ramp` → `lever.co`), not the company's own domain. **Accepted resolution
   (reverses spec's jobhive-primary emphasis):** make the domain-bearing datasets PRIMARY — remoteintech ships `website`+`careers_url`
   and yc-oss ships `website`, so run the ATS-signature regex on each to derive
   `(connector, slug, companyDomain, careersUrl)` directly (this keeps "join on domain, never
   name" TRUE). Treat jobhive as a SUPPLEMENTARY slug/validation pool: attach `companyDomain`
   only when a jobhive row name-matches a dataset (soft signal, tagged provenance), else leave
   `companyDomain` absent → Wave 3 dedupe falls back to `companySlugFor` (fine for pure-ATS
   sources). The initial ~200–300 ramp can come from the domain-grounded datasets alone,
   deferring the jobhive name-join entirely. Wave 2's Task 3 already built the join *primitive*
   generically, so only the wiring/orchestration reflects this choice.
2. **Migration numbering.** A concurrent **membership-credits** stream is live on `main`
   (staged `users.plan` + `credit_ledger` in `schema.ts`) and will claim `0002_*`. Remote-startup
   migrations therefore start at **`0003_*`+**. All plans say "don't hardcode — `db:generate`
   assigns the real number," so they degrade safely; Wave 1 Task 5's literal `0002` paths must
   be treated as "whatever `db:generate` emits."
3. **`careersUrl` in `SourceConfig`.** Re-detection (§3.6) and dataset-primary detection (#1)
   both need it. Promote it from a `.passthrough()` extra key to an explicit optional field
   (`careersUrl: z.string().url().optional()`) so it is fail-loud-validated.
4. **Membership-credits concurrency.** Both streams are live on `main`. Branch/sequencing is
   the operator's call — this program does not touch the credit model (scan stays 10 credits).

**Unknowns to resolve before the Wave 2 real-data run** (all flagged as manual pre-tasks, not
fabricated): jobhive CSV pinned URL/commit (`kalil0321/ats-scrapers`); yc-oss / remoteintech /
topstartups.io dataset URLs; Aspire's real ATS slug (`aspire` 404s).
