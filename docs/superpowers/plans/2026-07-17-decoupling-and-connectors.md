# Decoupling & New Connectors — Execution Plan (Phases 3 & 4)

Derived from `docs/superpowers/specs/2026-07-16-remote-startup-niche-source-expansion-design.md`
(operator-approved design, 2026-07-16) and the program plan
`docs/superpowers/plans/2026-07-17-remote-source-expansion.md` (this document expands its
Phase 3 M3.1–M3.5 and Phase 4 M4.1–M4.6 milestones to execution grain). Plan written 2026-07-17.

## Context

Phase 1 (matching fix) is **done** in the `remote-source-matching-fix` worktree: `roleMatch.ts`
is de-biased (role acronyms, single-non-baseline-token rule) and `sortCandidatesForRanking`
(`run.ts:522`) makes the top-N slice deterministic. Phase 2 (company-list engine, tasks 2.1–2.6)
is **in flight** — this plan assumes it lands as specified in the program plan and flags every
decision that depends on its landed shape with a `[P2-x]` marker (reconcile after Phase 2 merges;
see the P2 register at the bottom of this section).

Phase 3 decouples ingestion from matching: a scheduled crawler fills a global `postings` pool
once, and a user scan becomes stage-1 filter over the pool → cheap LLM function classifier →
deep score. The re-plan (rather than straight-build) was driven by the libsql `file:` driver
forbidding concurrent `db.transaction` — the crawler's write shape must be small sequential
batches, WAL + busy-timeout (already applied: `db.ts:25-29`), never long transactions.

Phase 4 adds new connectors in verified priority order (Workable → Recruitee → Personio →
Pinpoint → Rippling → gated SmartRecruiters). Per design §5, **live endpoint verification is a
prerequisite operator step per connector**, not a test — the build itself is subagent-able once
the verified shape is documented.

**Phase-2-dependency register** (every `[P2-x]` in the tasks below points here):

| # | What Phase 2 lands | Who consumes it here |
|---|---|---|
| P2-A | Health/provenance keys in `sources.config` (2.5: `provenance[]`, `companyDomain`, `lastValidatedAt`, `jobCount`, `consecutiveFailures`, `status`) — exact key names/shape | 3.4 crawler skip rule (`status='dead'` rows never crawled); 3.1 global key (`companyDomain` input) |
| P2-B | `src/server/sources/validate.ts` module shape (2.4: injected fetch, per-host cap, endpoint map) | 4.xb tasks add vendor endpoints; 3.4 may reuse its per-host politeness helper |
| P2-C | `src/server/sources/jobhive.ts` parser shape (2.2) | 4.1b extends it for the Workable CSV |
| P2-D | `src/server/sources/freshness.ts` ATS-signature regex table + config-rewrite mechanism (2.6) | 4.xb tasks add each vendor's signature regex; re-detection must recognise the new FACTORIES keys |
| P2-E | `bulkInsert` on `repos/sources.ts` (2.5) | 4.xb seeding reuses it |
| P2-F | The actual ramp count enabled after Phase 2 (~200–300, rest held) | 3.9 rollout baseline + "flip on the full validated list" |
| P2-G | Engine-seeded source id scheme (design example `gh:vercel` vs existing seeds `gh-stripe`, `seed.ts:22`) | 3.4 crawler stats keys; 4.xb seed ids must match whatever 2.5 landed |

## Spec references

- Design §4.4 (decoupling: pool, crawler, write constraints, `jobs` as match view), §4.1
  (two-stage matching + function tagging), §4.2 Tier 2 (verified connector mechanics),
  §4.3 (engine machinery the connectors ride), §5 (testing: determinism, dedupe collisions,
  batch-write behaviour, live-verify-as-prerequisite), §6 (rollout order 3→4), §7 (legal:
  403/429 stop signal, honest UA, JobStreet capped, Getro out), §8 (ceiling — do not market
  CEO-search), §9 (credits unaffected; per-user `jobs` kept), §10 (out of scope).
- Program plan: Phases 1–2 task grain, M3.1–M3.5 / M4.1–M4.6 milestone text.
- `docs/architecture/system-architecture.md` §6 decision 8 (per-run score cap ~30) — note the
  design §2 decision 2 says "~40"; see Risks.

## Gap analysis

All line numbers from the `remote-source-matching-fix` worktree (Phase 1 applied).

| Area | Exists (file:line) | Needed | Delta | Risk |
|---|---|---|---|---|
| Global postings pool | **does not exist** — postings are transient per run (`run.ts:253` `matchedPostings`) and upserted straight into per-user `jobs` (`run.ts:341`→`481`; `schema.ts:176` `unique(userId, dedupeKey)`) | `postings` table (no `userId`), additive migration, repo | Net-new table + `postingsRepo` | Med — additive migration only, no destructive step |
| Global dedupe key | per-run collision grouping only (`run.ts:426-454` `groupByCollision`; `dedupe.ts:55` `secondaryKey`, `:70` `resolveCanonicalCollision` ATS>board) | ATS `externalId` else normalized company-domain+title+location-bucket; ATS-direct beats aggregator | Net-new pure module reusing `companySlugFor`/`roleTokensHash` | Med — location-bucket rule not defined by design (see 3.1) |
| Crawler | none — discovery runs per user scan (`run.ts:278-338`, global `pLimit(8)` `run.ts:62`); boot-worker pattern exists to mirror (`url-check/worker.ts:1-9` globalThis-guarded singleton; `instrumentation.ts:20-21` boot) | scheduled crawl of all enabled sources, per-vendor-host politeness, small sequential batch writes | Net-new `crawl.ts` + worker | **High** — write shape under libsql constraint; overlap guard |
| Write shape | `jobsRepo.upsertByDedupeKey` is already transaction-free select+insert (`jobs.ts:127-144`); WAL+busy_timeout applied for `file:` (`db.ts:25-29`); no batch upsert exists anywhere | multi-row upsert in small sequential batches, no `db.transaction` | `postingsRepo.upsertBatch` | High — the §5 batch-write test is mandatory |
| Function tagging | none — `RawPosting` has no function (`connector.ts:17-31`); `TaskName` has no classify task (`client.ts:9-19`) | coarse token tag + cheap LLM classifier, cached on the pool row (user-independent → classify once, all users benefit) | enum + deriver + new LLM task mirroring `correlate` (`correlate.ts:88-139` renderTemplate + bijection guard + one corrective retry; `models.yml:69-78`) | Med |
| Match loop | discovery and matching fused: `roleFuzzyMatch` gate inside the connector loop (`run.ts:314`), board sources bypass it (`run.ts:297-314`) | stage-1 filter over the pool → classifier on ambiguous survivors → deep score; `jobs` re-cast as match view | split `run.ts`; `sortCandidatesForRanking` (`run.ts:522`) + `scoreTopCandidates` (`run.ts:536`) survive intact | **High** — biggest integration; SSE/stats semantics shift |
| Per-user stamps | eligibility (profile.baseCountry) + tzBand stamped at upsert (`run.ts:470-499`) | same stamps at **admission** time (they are user-scoped — they cannot live on the global pool) | move call site, logic unchanged | Low |
| Descriptions | greenhouse stores up to 40k chars at discover (`greenhouse.ts:88-91`); lazy path exists (`describe.ts:15-27`) but **greenhouse/lever/ashby have no `fetchDetail`** — `ensureDescription` returns the job unchanged (`describe.ts:17-18`), and a non-empty pool excerpt would short-circuit it (`describe.ts:16`) into silently scoring on a truncated JD | design §4.4/§7 wants the pool excerpt-bounded + lazy full text | genuine design/code conflict → operator decision task 3.0 | **High** — scoring quality vs copyright posture |
| Crawl without a user | no connector consumes `ctx.targets` (verified: `grep targets src/server/search/connectors/*.ts` → no hits; jobstreet is query-scoped by `config.query`, `jobstreet.ts:84`) | crawler calls `discover` with `targets: []` | none — safe by construction | Low |
| Connector registry | `FACTORIES` = greenhouse/lever/ashby/jobstreet (`connectors/index.ts:15-20`); honest self-identifying UA shared (`_http.ts:5`) | +5–6 vendor factories (Phase 4) | one factory each; UA/403-behaviour inherited from `fetchJson` (`_http.ts:36-39` throws on non-2xx — a 403/429 fails the source loudly, never retried) | Med — live-verify prerequisite each |
| Contract | `Source`/`SourceRef` exist (`types/index.ts:61-78`); `ScanStats`/`ScanFrame`/`SourceEventData` on the wire; no Posting/JobFunction entity | `JobFunction` enum in `src/types`; `Job`/`SearchRun` wire shapes unchanged; `ScanStats` shape kept, semantics re-documented | small contract addition | Low — `npm run contract:check` gates |
| Credits | scan debit at admission (`run.ts:134` `assertAndDebit`) | unchanged (design §9) | none | — |

## Tasks

Legend: `model:` fittest model · `@agent` executor · `exec:` subagent (autonomous, test-gated) or
session (operator genuinely required — each states exactly what the operator decides/verifies and
what evidence unblocks the follow-up). Test gate per task: `npm test`. Merge gate: `npm run check`.

### Phase 3 — Decoupling ingestion from matching. Sequence 3.0 → 3.9; nothing in Phase 4 starts before 3.9 passes. ~1.5–2 weeks.

- [ ] **3.0 DECISION — posting-description storage posture (gates 3.2's column shape).**
  Goal: resolve the design/code conflict the gap table names: design §4.4 says the pool is
  "excerpt-bounded" (§7: short excerpt + link-out is the copyright mitigation), but scoring
  quality depends on the full JD, `ensureDescription` short-circuits on any non-empty
  description (`describe.ts:16`), and greenhouse/lever/ashby have **no `fetchDetail`** — so an
  excerpt-bounded pool silently scores candidates on truncated JDs unless per-job detail
  endpoints are added and verified.
  - Operator must decide ONE of:
    - **Option A (larger pool, zero new endpoints):** pool `description` stores the crawl-time
      text as-is (existing 40k cap, same as `jobs.description` today). Copyright posture:
      unchanged from current behaviour; excerpting deferred until legal posture demands.
    - **Option B (design-literal):** pool stores a ~2,000-char `descriptionExcerpt`; admission
      copies the excerpt; `ensureDescription` is taught to treat an excerpt-flagged description
      as "missing" and fetch full text via NEW `fetchDetail` on greenhouse/lever/ashby.
      Prerequisite evidence: operator live-curls each vendor's per-job detail endpoint
      (greenhouse `boards-api.greenhouse.io/v1/boards/{slug}/jobs/{id}` is used for
      `?questions=true` at `greenhouse.ts:110-112` but its `content` payload is **UNVERIFIED**;
      lever/ashby per-job endpoints are **UNKNOWN** — do not invent them) and saves one sample
      JSON per vendor under `src/server/search/connectors/__fixtures__/`.
  - Evidence that unblocks 3.2: the option letter recorded in this file's checkbox line, plus
    (Option B only) the three fixture files. Confidence in the decision inputs: 95% (both
    options fully scoped).
  - `model:fable` `@operator` `exec:session` — legal-vs-quality tradeoff the design left
    contradictory; cannot be pre-decided.

- [ ] **3.1 Global dedupe key module (pure).**
  Goal: `globalKeyFor(posting, source)` — the pool's identity — deterministic and collision-tested.
  - New `src/server/search/globalKey.ts`: if `posting.externalId` present →
    `` `${connectorKey}:${slug}:${externalId}` `` (connector key + slug from `source.config`,
    fail loud if an ATS row lacks either — mirrors `greenhouse.ts:70`'s no-slug throw); else
    normalized company identity + `roleTokensHash(title)` (`dedupe.ts:45`) + location bucket.
  - Company identity rule (explicit, not a fallback chain): use `config.companyDomain` when the
    source row carries it `[P2-A]`; a row without one (the 12 hand seeds + SEA seeds, `seed.ts:22-33`)
    uses `companySlugFor(posting.company)` (`dedupe.ts:36`) — both paths stated in the key's
    prefix (`dom:` / `slug:`) so the two namespaces can never collide silently.
  - Location bucket v1 = `location.toLowerCase().trim()` — exactly `secondaryKey`'s existing
    rule (`dedupe.ts:56`), absent → `""`. The design does not define a smarter bucket
    (**UNKNOWN**, see Risks); city-normalization is out of scope.
  - Test must pass: externalId path stable across URL changes; no-externalId path collides for
    same company+title+location and separates on each axis; `dom:`/`slug:` namespaces disjoint;
    two sources same slug different connector do not collide.
  - Acceptance: `npx vitest run src/server/search/globalKey.test.ts` green.
  - Files: `src/server/search/globalKey.ts` (+ test).
  - `model:sonnet` `@general-purpose` `exec:subagent`. Confidence 90%.

- [ ] **3.2 `postings` table + additive migration + repo (batched, transaction-free).**
  Goal: the global pool exists with a write shape that survives the libsql `file:` constraint.
  - `schema.ts`: new `postings` table — `id` (uuid pk), `globalKey` text unique, `sourceId` FK
    `sources.id`, `externalId` nullable, `url`, `title`, `company`, `location` (`""` normalized,
    mirroring `run.ts:491`), `salaryRaw`, description column per **3.0's decision**, `postedAt`,
    `firstSeenAt`/`lastSeenAt`, `function` nullable text enum (11 design functions + `other`),
    `functionSource` nullable enum `tokens|llm` (both null until tagged — never a fabricated
    value), `raw` json, index on `(sourceId)` and `(lastSeenAt)`. **No `userId` — deliberately.**
  - Migration: `npm run db:generate` — additive table only, nothing destructive, no operator
    gate needed.
  - `repos/postings.ts`: `upsertBatch(rows)` — chunks of ≤50 as single multi-row
    `INSERT ... ON CONFLICT(globalKey) DO UPDATE set lastSeenAt/postedAt/description/raw`,
    issued **sequentially, no `db.transaction` anywhere in the file** (pin with a test that the
    repo never calls `db.transaction` — inject a Db spy); `listForScan(persona)` — join
    `sources` on enabled + persona (postings carry no persona; the source row does,
    `sources.ts:26-31` is the read to mirror); `setFunction(id, fn, source)`.
  - Test must pass: upsert round-trip; re-sighting updates `lastSeenAt` and never `firstSeenAt`;
    global-key conflict collapses to one row; batch of 120 rows issues ≥3 sequential statements
    and zero transactions; `listForScan` filters by source enabled+persona.
  - Acceptance: `npm test` green; `drizzle/` has exactly one new migration file.
  - Files: `src/server/persistence/schema.ts`, `src/server/persistence/repos/postings.ts`
    (+ test), new `drizzle/00xx_*.sql`.
  - `model:opus` `@general-purpose` `exec:subagent` — schema + write-shape correctness. Confidence 85%.

- [ ] **3.3 `JobFunction` enum (contract) + coarse token tagger.**
  Goal: every §4.1 function (eng/product/design/ops/finance/legal/marketing/sales/people/cs/exec)
  derivable from title tokens, with `ambiguous` as the honest "classifier needed" outcome.
  - `src/types/index.ts`: `JobFunction = z.enum([...11 functions, "other"])` — contract addition;
    `Job`/`SearchRun` wire shapes unchanged (the tag is pool/internal for now), so
    `npm run contract:check` must show openapi.json unchanged unless the enum is deliberately
    registered — do NOT register it as a wire schema in this task.
  - `src/server/search/functionTag.ts`: `deriveFunctionTag(title): JobFunction | "ambiguous"` —
    keyword table over `roleTokens(title)` (reuse `roleMatch.ts:68` — the de-biased tokenizer,
    `ROLE_ACRONYMS` at `roleMatch.ts:54` already carries ceo/cfo/vp/hr/ae/sdr/csm); exec wins
    over function when both present ("VP of Marketing" → marketing per design §3's fixture
    framing — pin whichever the fixtures say; the design's own table treats VP-of-X as the X
    function for matching purposes).
  - Test must pass: the design §3 table titles each map to a sane function (CEO/CFO/Chief of
    Staff → exec; Head of Finance → finance; Recruiter → people; Operations Manager → ops;
    Backend Engineer → eng; Account Executive → sales; Customer Success Manager → cs);
    "Manager" alone → ambiguous; a nonsense title → ambiguous (never a silent `other`).
  - Acceptance: `npm test` + `npm run contract:check` green.
  - Files: `src/types/index.ts`, `src/server/search/functionTag.ts` (+ test).
  - `model:opus` `@general-purpose` `exec:subagent` — the keyword table is fuzzy-judgment core.
    Confidence 85%.

- [ ] **3.4 Crawl core — `crawlSources()` with per-vendor politeness and tolerated failures.**
  Goal: one pass over all enabled sources fills/refreshes the pool; a bad source never kills the
  crawl; writes obey the batch shape.
  - `src/server/search/crawl.ts`: `crawlSources(sources, deps)` — per-vendor-host `pLimit(2)`
    keyed by `config.connector ?? source.id` (the FACTORIES key IS the vendor host,
    `connectors/index.ts:25`); `connector.discover({ targets: [], since, signal, onProgress })`
    (safe: no connector consumes targets — gap table); postings mapped through `globalKeyFor` +
    `deriveFunctionTag` (stamp `functionSource:'tokens'` only when unambiguous; ambiguous stays
    null for 3.6); collision within a crawl resolved ATS-beats-aggregator via
    `resolveCanonicalCollision` semantics (`dedupe.ts:70` — kind precedence; today all sources
    are ats/board so the rule is inherited, aggregator kinds arrive only if Himalayas ever
    ships); `postingsRepo.upsertBatch` per source as results accumulate (small batches, between
    sources — never one giant end-of-crawl write); per-source try/catch into a
    `{sourceId, found, errors}` stats array mirroring `run.ts:319-327`'s tolerated-failure
    comment; a `ConnectorHttpError` with status 403/429 is recorded AND logged with a
    `LEGAL-STOP` prefix — the crawl continues past the source but never retries it in-run
    (design §7: stop signal, not an obstacle). Skip sources whose `config.status === 'dead'`
    `[P2-A]` — key name per Phase 2's landed shape.
  - Test must pass (design §5 "crawler/pool"): fixture connectors (mirror
    `connectors/fixture.ts` seam via injected `connectorForSource`, same as `run.ts:82`) —
    per-vendor cap respected (in-flight counter on a mocked discover); one throwing source →
    crawl completes, stats carry its error; 403 → LEGAL-STOP logged, no retry; global-key
    collision across two sources → one pool row, ATS canonical; re-crawl updates `lastSeenAt`
    only; **write-interleaving test**: a concurrent `jobsRepo.upsertByDedupeKey` against the
    same test DB during a crawl batch does not error (WAL + busy_timeout + no transactions —
    the §5 "batch-write behaviour under the no-concurrent-`db.transaction` constraint" test).
  - Acceptance: `npx vitest run src/server/search/crawl.test.ts` green; `npm test` green.
  - Files: `src/server/search/crawl.ts` (+ test).
  - `model:opus` `@general-purpose` `exec:subagent`. Confidence 80%.

- [ ] **3.5 Crawler worker — boot-started, overlap-guarded, operator-triggerable.**
  Goal: the crawl runs on a schedule without a user in the loop, exactly one instance ever.
  - `src/server/search/crawlWorker.ts`: mirror `url-check/worker.ts`'s pattern quoted lines —
    globalThis-guarded singleton (worker.ts:1-9 comment block is the reference), `start()` wired
    in `instrumentation.ts` alongside `urlCheckWorker.start()` (`instrumentation.ts:20-21`),
    interval default **6h (4×/day — the design's upper cadence)** as a named exported constant,
    overridable via `CALIBER_CRAWL_INTERVAL_MS` (validated: non-numeric throws, mirroring
    `worker.ts` `readDailyCapUsd`); an in-flight flag skips a tick if the previous crawl is
    still running (overlap guard — two concurrent crawls would violate the single-writer
    posture); each completed crawl logs one summary line (sources, found, errors, ms).
  - `package.json`: `"crawl:once": "tsx --env-file-if-exists=.env.local src/server/search/crawl-cli.ts"`
    — the operator's manual trigger (used by 3.9 and every Phase-4 pilot); the CLI exits
    explicitly like `seed.ts:98-99`.
  - Test must pass: double `start()` → one interval; tick during in-flight crawl skipped;
    bad env value throws at start, not mid-tick.
  - Acceptance: `npm test` green; `npm run crawl:once` runs against a seeded test DB with the
    fixture connector (CALIBER_TEST_DOUBLES=1) and prints a summary.
  - Files: `src/server/search/crawlWorker.ts` (+ test), `src/server/search/crawl-cli.ts`,
    `src/instrumentation.ts`, `package.json`.
  - `model:sonnet` `@general-purpose` `exec:subagent`. Confidence 85%.

- [ ] **3.6 `function-classify` LLM task (mirrors `correlate`).**
  Goal: ambiguous pool postings get a function from the cheap tier, once, cached globally.
  - `client.ts:9`: add `"function-classify"` to `TaskName`. `config/models.yml`: new task block —
    `openai/gpt-oss-120b`, `maxTokens: 4000`, `temperature: 0.1`, `strict: true` (the `correlate`
    block at `models.yml:69-78` is the reference — quote it in the PR). New
    `config/templates/function-classify.md` in the `--- system --- / --- user:x ---` block format
    (`templates.ts:1-11`): input is a JSON array of `{id, title, company}`, output
    `{rows: [{id, function}]}` with function constrained to the `JobFunction` enum incl. `other`.
  - `src/server/search/functionClassify.ts`: batch wrapper mirroring `classifyRequirements`
    (`correlate.ts:83-139`) — id-bijection guard (every id exactly once, no unknown ids), one
    corrective re-ask, then fail loud; caps a batch at ~50 titles per call; writes results back
    via `postingsRepo.setFunction(id, fn, 'llm')`. Never called at crawl time — only from the
    scan path (3.7) on stage-1 survivors, so classification cost is demand-driven and each
    posting is classified at most once ever (cache check: `function` already set → skip).
  - Test must pass (mock LLM, `makeMockLlm` seam): bijection violations trigger exactly one
    retry then throw; cached postings are not re-sent; batch chunking at 50; results persisted
    with `functionSource:'llm'`.
  - Acceptance: `npm test` green.
  - Files: `src/lib/llm/client.ts`, `config/models.yml`, `config/templates/function-classify.md`,
    `src/server/search/functionClassify.ts` (+ test).
  - `model:sonnet` `@general-purpose` `exec:subagent` — pattern-following build. Confidence 85%.

- [ ] **3.7 Stage-1 pool matcher.**
  Goal: pool → ranked candidate list for one user, deterministic, two-stage per design §2
  decision 2.
  - `src/server/search/matchPool.ts`: `stage1MatchPool({ targets, persona, profile, llm })` —
    (a) `postingsRepo.listForScan(persona)`; (b) `roleFuzzyMatch` gate per posting using the
    Phase-1 de-biased matcher (`roleMatch.ts:124`) — **board-kind sources keep their bypass**
    exactly as `run.ts:297-314` documents (query-scoped upstream; the bypass moves here with its
    comment); (c) function gate: user functions = set of `deriveFunctionTag` over
    `targets[].titles` (ambiguous résumé titles resolved through `functionClassify` in the same
    batch call); survivors with a null/ambiguous function → one `functionClassify` batch (≤200
    by construction of the stage-1 gate); a posting whose resolved function is not in the user's
    set AND not `other` is rejected — `other` passes to deep scoring rather than being silently
    dropped (stated rule, not a fallback: `other` means "the cheap tier could not place it", and
    deep scoring is the arbiter); (d) deterministic ranking: `(postedAt desc — nulls last,
    globalKey asc)` — same shape as `sortCandidatesForRanking` (`run.ts:522-529`).
  - **Stated assumption (design gap, see Risks):** the design says "classifier resolves only the
    ambiguous ones on ~200 survivors → deep scoreMatch on ~40" but never defines how 200→40 —
    this plan's rule is: function-gate rejection + deterministic rank + the existing
    `TOP_N_CANDIDATES` slice (which stays **30** per `run.ts:34` / system-architecture decision 8
    unless the operator bumps it — flagged in Risks).
  - Test must pass: §3 fixture titles admit across functions; function gate rejects a
    cross-function posting that title-tokens alone would pass; `other` postings survive to the
    ranked list; shuffle-input determinism (byte-identical ranked output — extends the Phase-1
    determinism test to the pool path); classifier called only for null-function survivors.
  - Acceptance: `npx vitest run src/server/search/matchPool.test.ts` green.
  - Files: `src/server/search/matchPool.ts` (+ test).
  - `model:opus` `@general-purpose` `exec:subagent`. Confidence 80%.

- [ ] **3.8 Split `run.ts` — user scan reads the pool; `jobs` becomes the match view.**
  Goal: `startSearch` no longer fans out to the network; scan wall-clock = scoring time only;
  every per-user semantic (`isNew`/`firstSeen`/`dedupeKey`/eligibility/credits) preserved.
  - `runFanOut` (`run.ts:229`) is replaced by a match loop: `stage1MatchPool` → **admission**:
    each surviving pool posting is upserted into the user's `jobs` through the existing
    `upsertMatchedPostings` path with its eligibility + tzBand stamps computed AT ADMISSION
    (`run.ts:470-499` logic moves intact — these read `profile`, which is why they cannot run in
    the crawler); `dedupeKeyFor(url)` normalization unchanged (`run.ts:483`), so re-admission of
    a re-sighted posting refreshes `lastSeenAt` and preserves `firstSeenAt` (`jobs.ts:127-144`)
    — `isNew` semantics intact per design §4.4. Then `scoreTopCandidates` (`run.ts:536`)
    **unchanged** — its filters, cap gates, SSE phases, skip gate, and `sortCandidatesForRanking`
    all survive as-is.
  - Credits: `assertAndDebit` at `run.ts:134` untouched (design §9 — discovery cost leaves the
    scan; the 10 credits still buy the deep scores).
  - Stats/SSE reconciliation (shape-preserving, semantics re-documented): `stats.perSource` =
    admitted candidates grouped by pool `sourceId` (found = admitted count, errors = 0 — connector
    errors now live in crawl logs, not scan stats); `discoverMs` = stage-1+classify wall time;
    `scanned` = pool rows considered; SSE `source` events are no longer emitted during a scan
    (nothing is fetching) — `ScanFrame.sources` stays `[]`, progress stages become
    `match → score → legitimacy`. `ScanStats`/`ScanFrame`/`SourceEventData` Zod shapes are NOT
    changed — `npm run contract:check` must pass with zero openapi diff. UI-visible change
    (empty source strip) flagged for the operator in 3.9.
  - `groupByCollision`/`upsertMatchedPostings` stay for the admission path (pool rows from
    different sources can still collide per-user); the old discovery loop, its
    `connectorTimeoutMs` dep, and dead code are removed — `deps.connectorForSource` remains only
    where describe.ts needs it.
  - Test must pass: full-scan integration test on fixture pool rows (seeded via `postingsRepo`)
    — admission writes jobs with correct eligibility/tz stamps; `firstSeenAt` stable across two
    scans; determinism (shuffled pool insertion order → byte-identical top-N — the Phase-1 test
    re-pointed at the pool path); credits debited exactly once; existing `run.test.ts` blocks
    updated, none silently deleted (each removal justified in the diff).
  - Acceptance: `npm test` green; `npm run check` green (contract diff zero).
  - Files: `src/server/search/run.ts`, `src/server/search/run.test.ts`,
    `src/server/search/matchPool.ts` (wiring only).
  - `model:opus` `@general-purpose` `exec:subagent` — core-correctness integration. Confidence 75%.

- [ ] **3.9 Rollout — live crawl, verify, then flip on the full validated list.**
  Goal: the decoupled pipeline observed working on real data before the held-back sources enable.
  - Operator (on the box, `.env.local` DB): (1) `npm run crawl:once` over the Phase-2 ramp set
    (~200–300 enabled sources `[P2-F]`); verify: pool row count sane (~tens of thousands per
    design §4.4), per-source stats show no LEGAL-STOP lines, crawl wall-clock recorded;
    (2) run a real scan per persona; verify: scan completes in scoring-time-only wall-clock,
    feed shows cross-function results, `stats.perSource` populated, empty source strip is
    acceptable UX (flagged from 3.8 — if not, a UI follow-up task is filed, not improvised);
    (3) enable the remaining validated sources (the "flip", design §6.3) in batches of ~250 with
    a `crawl:once` + spot-check between batches; (4) confirm JobStreet's crawl volume is
    UNCHANGED from its per-scan cap (~90 postings, `config` caps at `seed.ts:37-43` — design §7:
    do not scale JobStreet with this expansion).
  - Evidence that closes this task: crawl summary lines + scan run ids + final enabled-source
    count recorded in the PR/session log. Any 403/429 during the flip = stop, disable that
    vendor batch, record it — never work around (design §7).
  - `model:sonnet` `@operator` `exec:session` — live verification + staged enablement judgment;
    genuinely cannot be a subagent.

### Phase 4 — New connectors, verified priority order M4.1→M4.6. Post-3.9 only. Sequence, don't batch.

Per-connector shape: **(a) live verification is an operator prerequisite** (design §5) — it
produces committed fixture evidence; **(b) the build is a subagent task** riding that evidence.
Per-connector go-live is then the standing operator checklist (not separate tasks): run the
Phase-2 validation script over the vendor's slugs `[P2-B]`, bulk-seed `[P2-E]` with persona
`remote` + a `config.geo` annotation per `parseSourceGeo`'s requirements (`geo.ts:116-136` — ats
rows NEED `geo.scope`, fail-loud), enable a pilot batch of ≤20, `npm run crawl:once`, verify
postings + zero 403/429, then widen. Every connector build also adds: its endpoint to the
validation map `[P2-B]`, its ATS-signature regex to freshness re-detection `[P2-D]`, and its
FACTORIES entry (`connectors/index.ts:15`). All HTTP through `fetchJson`/`postJson` (`_http.ts`)
— honest UA and loud 403/429 inherited; never add a browser-spoofing header (design §7).

- [ ] **4.1a Workable — live verification (operator).**
  Verify: `GET apply.workable.com/api/v1/widget/accounts/{slug}` and `?details=true` on 2–3
  slugs (one SEA if findable) — confirm the §4.2 payload claims: `function` field, `department`,
  `telecommuting` bool, `locations[]`, `application_url`, stable `shortcode`, full description
  under `details=true`, full list in one call (no pagination), `robots.txt` still fully open.
  Also confirm the jobhive Workable CSV **exists and its schema** (the design asserts ~4,269
  slugs; the vendored Phase-2 CSVs are greenhouse/ashby/lever — the Workable file is
  **UNVERIFIED**) `[P2-C]`.
  Evidence that unblocks 4.1b: one full sample JSON per endpoint variant committed under
  `src/server/search/connectors/__fixtures__/workable-*.json` + CSV schema note in the task
  checkbox. `model:sonnet` `@operator` `exec:session`.
- [ ] **4.1b Workable connector + integration.**
  `connectors/workable.ts` factory (`discover()` yielding `RawPosting` — map `telecommuting` into
  `RawPosting.geo` via the existing `ParsedGeo` shape (`geo.ts:6`), `shortcode` → `externalId`,
  `application_url` → url; description from `details=true` per 3.0's posture) + FACTORIES entry +
  validation endpoint `[P2-B]` + signature regex `[P2-D]` + jobhive ingest extension for the
  Workable CSV `[P2-C]`. Tests off the 4.1a fixtures: discover mapping, geo flag, missing-slug
  throw (mirror `greenhouse.ts:70`), 403 surfaces as `ConnectorHttpError`. Acceptance: `npm test`
  green; connector resolves through `connectorForSource` for a seeded fixture row.
  Files: `src/server/search/connectors/workable.ts` (+ test), `connectors/index.ts`,
  `src/server/sources/{validate,freshness,jobhive}.ts` (names per Phase 2's landed modules).
  `model:sonnet` `@general-purpose` `exec:subagent`. Confidence 85% (with 4.1a evidence).

- [ ] **4.2a Recruitee — live verification (operator).**
  Verify `GET https://{slug}.recruitee.com/api/offers/` on 2–3 slugs: field names for title/
  location/remote flag/`careers_apply_url`/description/id, list-in-one-call vs pagination
  (**UNKNOWN** — design is silent on pagination), robots posture. Slug supply is **UNKNOWN**
  (no jobhive CSV claimed) — confirm the careers-url re-detection funnel `[P2-D]` is the only
  source and note expected volume. Evidence: fixture JSON committed. `model:sonnet` `@operator`
  `exec:session`.
- [ ] **4.2b Recruitee connector + integration.**
  Same shape as 4.1b (factory + FACTORIES + validation endpoint + signature regex
  `{slug}.recruitee.com`). Tests off 4.2a fixtures. `model:sonnet` `@general-purpose`
  `exec:subagent`. Confidence 85% (with evidence).

- [ ] **4.3a Personio — live verification + XML-parser dependency decision (operator).**
  Verify `GET https://{slug}.jobs.personio.com/xml?language=en` on 2–3 slugs: XML schema
  (element names for title/office/department/description/id), remote-in-office-string convention
  (§4.2: no boolean flag). **Operator decision in this task:** approve the XML parsing approach —
  recommended `fast-xml-parser` (new dependency, no native code) vs hand-rolled — a dependency
  addition is an operator call. Slug supply **UNKNOWN** (careers-url funnel only). Evidence:
  fixture XML + the parser decision recorded. `model:sonnet` `@operator` `exec:session`.
- [ ] **4.3b Personio connector + integration.**
  Factory parsing the verified XML (fail loud on missing required elements — no defaulted
  fields), remote detection from the office string per 4.3a's documented convention, signature
  regex `{slug}.jobs.personio.com`. Tests off 4.3a fixture XML incl. a malformed-XML loud
  failure. `model:sonnet` `@general-purpose` `exec:subagent`. Confidence 80% (XML cost).

- [ ] **4.4a Pinpoint — live verification (operator).**
  Verify `GET https://{slug}.pinpointhq.com/postings.json` on 2–3 slugs: payload fields,
  pagination (**UNKNOWN**), function breadth (design confirmed only a thin sample — record what
  the samples show). Slug supply **UNKNOWN** (careers-url funnel). Evidence: fixture JSON.
  `model:sonnet` `@operator` `exec:session`.
- [ ] **4.4b Pinpoint connector + integration.**
  Same shape as 4.1b. Tests off 4.4a fixtures. `model:sonnet` `@general-purpose` `exec:subagent`.
  Confidence 85% (with evidence).

- [ ] **4.5a Rippling — live verification (operator).**
  Verify `GET https://ats.rippling.com/api/v2/board/{slug}/jobs` AND the per-posting
  `/jobs/{id}` detail call (§4.2: descriptions are N+1) on 2–3 slugs. This surface is
  **undocumented** by Rippling — the operator must also accept the fragility posture (it can
  break without notice; the freshness loop's `consecutiveFailures` is the safety net). Record
  the N+1 politeness budget decision: detail calls happen ONLY via `fetchDetail` at scoring time
  (≤TOP_N per scan), never at crawl time — the crawler stores list-payload fields only.
  Evidence: both fixture JSONs. `model:sonnet` `@operator` `exec:session`.
- [ ] **4.5b Rippling connector + integration.**
  Factory with `discover()` (list payload only) + `fetchDetail()` (the N+1, scoring-time only —
  the first Phase-4 connector to implement it; `describe.ts:15-27` is the existing consumer).
  Tests: discover mapping, fetchDetail mapping, detail-call NOT made during discover.
  `model:sonnet` `@general-purpose` `exec:subagent`. Confidence 80% (N+1 + undocumented surface).

- [ ] **4.6a SmartRecruiters — hit-rate + legal gate (operator). GATES 4.6b.**
  The design's two blockers, both operator judgment: (1) run a 20–30-slug batch check against
  `api.smartrecruiters.com/v1/companies/{id}/postings` (5/7 returned zero live — staleness vs
  identifier mismatch unresolved); the design sets **no pass threshold** (**UNKNOWN**) — the
  operator sets one before running (suggested framing: proceed only if ≥50% of the batch returns
  >0 postings AND the failures are explainably stale, not identifier-scheme mismatches);
  (2) legal call on `robots.txt Disallow: /` — a signal none of the other Tier-2 vendors carry
  (design §4.2/§7); unauthenticated-but-contra-docs access + a blanket disallow may simply be a
  no. **No build happens on a fail — the task closes as "gated out" and 4.6b is struck.**
  Evidence that unblocks 4.6b: batch results table + explicit operator go/no-go in the checkbox.
  `model:fable` `@operator` `exec:session`.
- [ ] **4.6b SmartRecruiters connector + integration (CONDITIONAL on 4.6a go).**
  Same shape as 4.1b; jobhive carries 2,214 slugs on paper `[P2-C]`. `model:sonnet`
  `@general-purpose` `exec:subagent`. Confidence 80% (if gated in).

## Risks & uncertainties

- **3.0 is the plan's one true fork**: the design simultaneously mandates an excerpt-bounded pool
  (§4.4/§7) and lazy full descriptions via `ensureDescription` — but the three shipped ATS
  connectors have no `fetchDetail`, and `describe.ts:16` short-circuits on any non-empty text, so
  the literal design silently scores truncated JDs. Neither option is invented; both are scoped;
  the operator picks. Everything downstream (3.2's column, 3.8's admission copy, 4.5b's
  fetchDetail precedent) keys off it.
- **Stage-1 → deep-score funnel is under-specified** (design §2 decision 2: "~200 → ~40" with no
  cut rule). Pre-decided here as function-gate + deterministic rank + existing `TOP_N_CANDIDATES`
  slice — and TOP_N stays **30** (`run.ts:34`, system-architecture decision 8) though the design
  says "~40". One-constant change if the operator wants 40; do it consciously, not silently.
- **`other`-function postings pass to deep scoring** (3.7) — stated rule, not a fallback. Risk:
  a fat `other` bucket erodes the funnel; the 3.7 fixtures pin that the 11 named functions
  actually claim the §3 titles so `other` stays thin.
- **Global-key inputs are two-namespace** (`dom:` via `[P2-A]` companyDomain / `slug:` for
  hand-seeded rows) and the **location bucket v1 is the raw lowercased string** — the design
  defines neither precisely (UNKNOWN). Consequence of a weak bucket: duplicate pool rows for
  "Remote" vs "Remote — EMEA", not data loss. Accepted for v1.
- **Scan UX visibly changes** (3.8): no per-source fetch strip during a scan; `stats.perSource`
  errors always 0 (connector errors moved to crawl logs). Wire shapes unchanged, semantics
  re-documented; operator accepts or files a UI follow-up at 3.9 — not improvised mid-build.
- **Pool growth/pruning is unspecified** (design: ~100–300k rows/year "with churn" but no
  expiry/prune policy — UNKNOWN). Not built; if crawl summaries show unbounded growth, that is a
  new plan, not a quiet DELETE.
- **Phase-4 slug supply**: only Workable has a claimed bulk CSV (itself UNVERIFIED, checked in
  4.1a); Recruitee/Personio/Pinpoint/Rippling depend on the careers-url re-detection funnel
  `[P2-D]` with UNKNOWN volumes — a verified connector may land with only dozens of sources to
  point at. That is fine (design: connectors are optional reach), but expectations are set here.
- **Legal constraints bind Phase 4 order and behaviour** (design §7): 403/429 is a stop signal
  wired into 3.4's LEGAL-STOP handling and every go-live checklist; JobStreet stays capped
  (verified in 3.9.4); Getro is out entirely; SmartRecruiters may be gated out at 4.6a — the
  plan treats that as a normal outcome, not a failure.
- **Rippling is an undocumented surface** — it can break silently; `consecutiveFailures` →
  `status='dead'` `[P2-A/D]` is the containment. The N+1 detail budget is scoring-time-only by
  construction (4.5a decision).
- **Everything marked `[P2-x]` is provisional** until Phase 2 merges — the orchestrator must
  reconcile key names (P2-A), module names/shapes (P2-B/C/D/E), the ramp count (P2-F), and the
  source-id scheme (P2-G) against the landed code before spawning 3.4, 4.1b, or any task that
  names them. Ten minutes of diff-reading, mandatory.

## Out of scope (design §10 + this plan)

- Any single-function board or exec-marketplace connector; Getro/Consider scrapers; Wellfound/
  LinkedIn/Indeed/Glassdoor in any form; paid feeds (jobdataapi.com).
- Himalayas (the only aggregator named Tier 2) — not scheduled here; the ATS-beats-aggregator
  rule in 3.1/3.4 is built so its arrival is additive, nothing more.
- A user-facing source picker; full-description mirroring beyond 3.0's decided posture;
  pool pruning/expiry; city-level location normalization for the global key.
- Scaling JobStreet volume; marketing CEO-search coverage (design §8).
- Reworking credits (design §9: unaffected) or the per-user `jobs` decision (kept, decision #5).

## Models & execution

- `model:` — `opus` = fuzzy judgment / core-correctness / schema+integration; `sonnet` = default
  build / pattern-following; `fable` = operator-facing decision framing (3.0, 4.6a).
- `@agent` — `general-purpose` executes build tasks; `@operator` marks the human in exec:session.
- `exec:session` tasks and why: **3.0** (design-contradiction decision + legal tradeoff),
  **3.9** (live crawl/scan verification + staged flip), **4.1a–4.5a** (live endpoint
  verification is a design-§5 prerequisite; 4.3a adds a dependency decision; 4.5a adds a
  fragility acceptance), **4.6a** (hit-rate batch + robots/legal go-no-go). Every session task
  states its unblocking evidence; everything else is subagent, test-gated.
- Sequencing: 3.0 → 3.1 → 3.2 → {3.3, 3.5, 3.6 parallelizable after 3.2; 3.4 needs 3.1+3.2+3.3}
  → 3.7 (needs 3.3+3.6) → 3.8 (needs 3.4 landed for integration fixtures + 3.7) → 3.9. Phase 4
  strictly after 3.9; within it a→b per vendor, vendors in order, one at a time.
- Per-task gate: `npm test` (`vitest run`); targeted: `npx vitest run src/server/search/`.
  Merge gate: `npm run check` (`typecheck && vitest run && contract:check && build`).
- Handoff: generate via `/subagent-handoff` AFTER Phase 2 merges and the `[P2-x]` register is
  reconciled; 3.0 must be answered before the handoff is cut (it shapes 3.2's schema).
