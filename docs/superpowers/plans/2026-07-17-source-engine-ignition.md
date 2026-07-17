# Source Engine — Ignition, Decoupling & Connectors — Implementation Plan

Written 2026-07-17, after operator decisions D1–D7 (below) and three live-data reports.
**Supersedes** `2026-07-17-decoupling-and-connectors.md` (written before the live findings;
its 3.0 fork and P2-A…P2-G register are now resolved and folded in here).

## Context

Phase 1 (matching fix) and Phase 2 (company-list engine) are built, reviewed, stress-tested
against live data, and integrated with `main` in worktree `remote-source-matching-fix`
(`npm run check` exit 0, 183 files / 1632 tests). What remains: land it, correct the spec it
disproved, actually run it on real data, then decouple ingestion and add connectors.

**The through-line of this program: unit fixtures lied three times** (B1 seniority regression,
B2 the 0-row domain join, and the matcher's 0.425 real-world recall behind green tests). Every
task below that touches matching or ingestion must be validated against real data, not fixtures.

## Operator decisions (2026-07-17) — binding

| # | Decision | Consequence |
|---|---|---|
| D1 | **Squash + merge** Phase 1+2 | Task 0.1 |
| D2 | **Pool stores full text at crawl time** (Option A) | Unblocks Phase 3 schema; `postings.description` ≤40k; copyright handled at the UI layer (excerpt + link-out), not storage |
| D3 | **Apply all six spec corrections** in-place | Task 0.2 |
| D4 | **Ignition = script + dry run, no seeding** | Task 0.3/0.4; seeding is a separate later go |
| D5 | **Build Recruitee's per-board robots gate** _(generalized 2026-07-17 into a per-tenant crawl-permission gate covering robots + Content-Signal, also gating Teamtailor — DECISION B)_ | Task 4.3a/4.3b/4.4 |
| D6 | **Order: Workable → Personio → Teamtailor → Recruitee → Pinpoint → Rippling (conditional)** _(amended 2026-07-17, DECISION B — see `reports/2026-07-17-handoff-integration.md` §1)_ | Phase 4 sequence; SmartRecruiters OUT |
| D7 | **Engine ids keep the colon** (`gh:vercel`) | No code change; already conformant |
| D8 | **Personio XML + Teamtailor RSS parse via `fast-xml-parser`** (one dep, both connectors) — resolves the parser fork reserved for the operator | Tasks 4.2, 4.3b |
| D9 | **`fetchDetail` interface unchanged** `{description, applyUrl?}` — detail-sourced `createdOn`/`companyName` are DROPPED; postedAt← pool `firstSeenAt`, company← source row (moot if Rippling is dropped, D11) | Task 4.6 |
| D10 | **Location-bucket v1 = the arch's proposed rule** (lowercase→remote-keyword→city-before-comma→empty; under-merge over over-merge) | Task P.2 |
| D11 | **Rippling — UNRESOLVED.** Operator asked to "bypass" the limit; declined — the endpoint is public/unauthenticated (no technical barrier to bypass), so the only "limit" is §7 ToS uncertainty, and evasion (proxies/UA-spoof/flag-off) is forbidden by §7 + the session's own precedent (SmartRecruiters/topstartups/Getro all dropped). Real choice remains **drop (recommended) / defer / verify a legitimate documented Rippling API exists**. No bypass will be built. | Task 4.6 |

## Spec references

- Design: `docs/superpowers/specs/2026-07-16-remote-startup-niche-source-expansion-design.md`
  — **contains six verified errors, corrected by task 0.2**. Until 0.2 lands, prefer the reports.
- Reports (measured, authoritative on facts): `docs/superpowers/reports/2026-07-17-{connector-live-verification,matching-stress-test,identity-verification}.md`
- Superseded plan: `2026-07-17-decoupling-and-connectors.md`.

## Gap analysis

| Area | Exists (file:line) | Needed | Delta | Risk |
|---|---|---|---|---|
| Engine chain | modules 01–06 all built + tested in isolation | one script wiring ingest→match→identity→validate→(seed) | Net-new `sources:engine` script + dry-run mode | **High** — never run on real data; the 90-min validation is inside it |
| Dataset vendoring | fixtures only; real CSVs/JSON live in a scratchpad | fetch-at-runtime or vendored | Decision + loader | Med — yc-oss has **no licence** (`license: null`); operator risk call |
| Spec truth | 6 wrong passages | corrected in place | Doc edit | Low, but compounding — CLAUDE.md points readers there first |
| `postings` table | **does not exist**; postings transient in `run.ts:253` → per-user `jobs` (`unique(userId,dedupeKey)` `schema.ts:176`) | global pool, no `userId`, `description` ≤40k (D2) | Net-new table + migration | **High** — libsql forbids concurrent `db.transaction`; `no-db-transaction.test.ts` on main now guards this |
| Crawler | none | fetch all enabled once, small sequential batches | Net-new | High — write shape bound by libsql single-writer |
| Function tag / classifier | none; `correlate` pattern at `client.ts:9` + `models.yml` | coarse function + LLM classifier | Net-new task block | Med — **Workable's `function` field is mostly empty in practice**, so no vendor shortcut exists |
| Matching residue | phrase-containment shipped (recall 0.722) | synonymy/morphology (Talent Acquisition↔Recruiter, Accounting↔Accountant) | Classifier work | Med — not thresholdable; explicitly Phase 3 |
| Connectors | `FACTORIES` `connectors/index.ts:15` = gh/lever/ashby/jobstreet | +5 vendors, all live-verified w/ fixtures | One factory each | Med — fixtures already captured, so builds are unblocked |
| Robots gate | none | per-board robots check (Recruitee) | Net-new, reusable | Med — D5 |
| `run.ts:280` | `resolveConnector` sits **outside** the per-source try (`:296`) | any throw rejects `Promise.all` → whole scan dies | Move inside try | Low fix, latent landmine (B3's trigger was removed, not the fragility) |

## Tasks

Legend: `model:` · `effort:` (per CLAUDE.md Effort Policy) · `@agent` · `exec:` subagent (autonomous,
test-gated) or session (operator in loop). Per-task gate: `npm test`. Merge gate: `npm run check`.

### Track 0 — Land it & tell the truth. ~1 day. **Do first; everything else assumes it.**

- [ ] **0.1 Squash + merge Phase 1+2 to main.** (D1)
  - Squash `4d8eaed` (wip) + `d5b6824` (merge-main) into one commit; merge to `main`; delete the worktree branch.
  - Test must pass: `npm run check` exit 0 on `main` post-merge.
  - Files: git history only.
  - `model:sonnet` `effort:low` `@general-purpose` `exec:session` — operator owns history. Confidence 95%.

- [ ] **0.2 Correct the six spec errors in place.** (D3)
  - §4.3.2 domain-join → inverted pipeline; §4.3.2 `1,500–4,000` → `~861`; §4.3.3 `4,848/4,966` → `4,966/4,966`;
    §4.3.5 `careers_url` → `companyDomain`-derived (+ note: raw-HTML scan found 0/25 — re-detection, not discovery);
    §4.2/§4.3 drop topstartups.io (403, terms UNKNOWN, §7 stop signal) + remoteintech licence `NOASSERTION`→`ISC`
    + repo restructured to `src/companies/*.md`; §4.2/§8 Workable `function` mostly empty, Rippling paginated,
    Recruitee robots per-tenant, SmartRecruiters robots `Disallow: /` (LinkedInBot allowlist).
  - Each edit cites the report proving it. Do NOT rewrite anything not on this list.
  - Test must pass: n/a (doc). Acceptance: operator reads the diff.
  - Files: the design spec.
  - `model:sonnet` `effort:medium` `@general-purpose` `exec:subagent`. Confidence 90%.

- [ ] **0.3 Build the engine chain script (`sources:engine`) with `--dry-run`.** (D4)
  - Wire ingest(`jobhive`)→niche(`nicheList`)→match(`nicheFilter`)→identity(`identity`)→validate(`validate`)→seed(`seedFromEngine`+`bulkInsert`).
    `--dry-run` (DEFAULT) runs everything and writes a report; seeding requires an explicit `--seed` flag.
  - Dataset access: resolve D-open (vendor vs fetch-at-runtime) — see Risks; fail loud if datasets absent.
  - Politeness: reuse `validate.ts`'s per-host limiter; any 403/429 → stop that host, record, continue others.
  - Resumability: the validate stage is ~90 min; a crash must not force a full restart (checkpoint the validated set).
  - Test must pass: chain runs end-to-end against **fixtures** with an injected fetch; `--dry-run` writes zero DB rows
    (assert via repo spy); `--seed` writes only identity-confirmed + validated rows; a 403 mid-run doesn't abort the pass.
  - Files: `src/server/sources/engine.ts` (+ test), `package.json` script.
  - `model:opus` `effort:xhigh` `@general-purpose` `exec:subagent` — multi-module orchestration + failure semantics. Confidence 80%.

- [ ] **0.4 OPERATOR: run the dry run on real data (~90 min).** (D4)
  - `npm run sources:engine -- --dry-run`. Produces the real numbers: candidates, identity confirmed/mismatch,
    live 200s, projected seed count.
  - Unblocks: the seed go/no-go, and 3.9's ramp baseline. **Report the real yield vs the ~861 projection.**
  - `model:n/a` `effort:n/a` `exec:session` — wall-clock + live network.

- [ ] **0.5 Move `resolveConnector` inside the per-source try (`run.ts:280` → inside `:296`).**
  - Any connector-resolution throw currently rejects `Promise.all` (`:338`) and kills the entire scan.
    B3 removed the trigger, not the fragility. One bad source must degrade to one skipped source.
  - Test must pass: a source whose connector resolution throws → that source records a failure in `stats.perSource`,
    the run completes and other sources still yield jobs.
  - Files: `src/server/search/run.ts` (+ test).
  - `model:sonnet` `effort:medium` `@general-purpose` `exec:subagent`. Confidence 90%.

### Track 2b — Matcher-side recall lift. ~2–3 days. **Ships BEFORE Phase 3; no pool/LLM/schema needed.**
_Measured by `docs/superpowers/reports/2026-07-17-matching-tiers.md` (620-row real JD corpus, unchanged oracle).
Takes recall 0.722 → 0.894 with deterministic, reviewable rules and cuts the eventual classifier's load ~60%._

- [ ] **2b.1 Curated synonym table + 4 folds at `deriveRoleTargets`.**
  - Adopt the **4-fold table** (extends the existing `developer→engineer` mechanism) + a **curated synonym table**
    (strict rules always-on; sibling rules with trigger hygiene — the study found + fixed two trigger bugs, mirror them).
    Entries are derived from the real corpus, NOT invented. Reviewable by a human; no LLM.
  - **SKIP, measured dead (do not implement — each is a net FP loss):** Porter/Snowball stemming (over-stems
    `marketing→market`, `officer→office`, breaks the head-noun path); JD-content matching in stage-1 (recall 0.502 /
    **1,673 FPs** — JD text matches everything); embeddings (semantic-only gap is ~0.9% of matches; every cosine
    threshold <0.7 nets more FPs than it rescues; real-embedding number UNKNOWN, no paid calls were made).
  - **FP cost is real and must be an operator-visible decision**: recall 0.722→0.894 comes with **FP 141→187 (+46)**.
    Dead zones open: people 0.23→0.86, risk 0.10→0.90, legal 0.27→0.69, marketing 0.38→0.79, cs 0.43→0.97.
  - Test must pass: measured recall/FP over `live-jd-sample.json` reported (not asserted from fixtures); every existing
    `roleMatch.test.ts` fixture stays green; each synonym rule pinned with a real corpus example both ways (match + a
    near-miss it must NOT admit).
  - Files: `src/server/search/roleMatch.ts` (+ test), synonym table (co-located or `roleSynonyms.ts`).
  - `model:opus` `effort:xhigh` `@general-purpose` `exec:subagent` — FP-boundary tuning on live data. Confidence 80%.

### Track 3 — Decoupling. ~1.5–2 weeks. **After Track 0. D2 resolved the blocking fork.**

> **SUPERSEDED by Track P** (`docs/superpowers/plans/2026-07-17-global-postings-pool-build.md`) — do not
> execute 3.1–3.6 below; they carry stale assumptions (3.4's `src/server/llm/…` path, 3.5's hard tz-gate
> semantics overridden by DECISION A full-soft-rank). Kept for historical reference only; Track P is the
> executable version of this work.

- [ ] **3.1 Global `postings` table + migration.** (D2: `description` TEXT ≤40k, stored at crawl time)
  - No `userId`. Global dedupe key: ATS `externalId` when present, else normalized `companyDomain` + title + location bucket.
  - Test must pass: migration up/down; the dedupe key is stable across re-crawls; **no `db.transaction`** (main's
    `no-db-transaction.test.ts` guard must stay green).
  - Files: `src/server/persistence/schema.ts`, migration, `repos/postings.ts` (+ tests).
  - `model:opus` `effort:xhigh` `@general-purpose` `exec:session` — schema is hard to walk back. Confidence 80%.

- [ ] **3.2 Scheduled crawler.**
  - Fetch every enabled source once (nightly / 2–4×/day), upsert `postings` in **small sequential batches, no long
    transactions** (libsql `file:` forbids concurrent `db.transaction`); WAL + busy-timeout already at `db.ts:25-29`.
    Per-vendor-host politeness. Skip `config.status === 'dead'` rows. `targets: []` is safe — **no connector reads
    `ctx.targets`** (verified by grep; jobstreet is `config.query`-scoped at `jobstreet.ts:84`).
  - Test must pass: write-interleaving test (crawler writes while a user scan writes — no `SQLITE_BUSY`); batch size
    bounded; a failing source doesn't abort the crawl; dead sources skipped.
  - Files: `src/server/sources/crawler.ts` (+ test).
  - `model:opus` `effort:xhigh` `@general-purpose` `exec:subagent`. Confidence 75%.

- [ ] **3.3 Global dedupe + canonical resolution.**
  - ATS-direct beats aggregator duplicates. Location-bucket definition is UNKNOWN in the design — v1: raw lowercased
    location per `dedupe.ts:56`; weak bucket degrades to duplicate pool rows, not data loss.
  - Test must pass: same job from two sources → one canonical row, ATS-direct wins; differing location strings bucket together.
  - Files: `src/server/sources/dedupe-global.ts` (+ test).
  - `model:opus` `effort:xhigh` `@general-purpose` `exec:subagent`. Confidence 75%.

- [ ] **3.4 Coarse function tag + LLM function classifier.** _(reshaped by the tier study — read
  `docs/superpowers/reports/2026-07-17-matching-tiers.md` §M3.4 impacts first; 2b.1 must land first, it cuts this load ~60%.)_
  - **Coarse `function` tag = dept-mapped, title fallback** — NOT title-tokens-only. Measured: all 2,909 harvested
    postings carry a board dept/team string; map that to the function enum, fall back to title tokens only when absent.
    **This field must land in the M3.1 `postings` schema** (add to 3.1's column list) — the classifier consumes it.
  - **No vendor shortcut** — Workable's `function` field is mostly empty in practice (verified).
  - Classifier scope is now the ~213 measured residue FNs (after 2b.1's synonym table): **judgment, not lookup** —
    altitude (SDR/Head-of on an AE résumé, ~70 rows), adjacency ("Recruiting Coordinator" vs Recruiter), form quirks.
  - `function-classify` shape (measured): receives function-gated stack-rejects as `{title, dept, first 300 JD chars}`,
    batched ~25/call; decides `match | altitude_mismatch(junior|senior) | adjacent_no | no`. Ambiguous band ≈24/target
    (~10% true); ~4 cheap calls per broad-function scan — **fits the 10-credit gate**. A perfect classifier ⇒ recall 0.942.
  - **JD text is stage-1 POISON** (measured: 1,673 FPs) — it may enter ONLY the classifier + deep-score inputs, never
    the stage-1 filter. Pin this as a test in 3.5.
  - `client.ts` TaskName + `models.yml` block + `renderTemplate` wrapper, mirroring `correlate`.
  - Test must pass: dept→function mapping over the **real** `live-titles.json` / `live-jd-sample.json`; classifier
    fail-loud on emission-schema drift (mirror `correlate`'s emission tests); measured band size + accuracy reported.
  - Files: `src/server/llm/…`, `config/models.yml`, `src/server/sources/function.ts` (+ tests).
  - `model:sonnet` `effort:xhigh` `@general-purpose` `exec:subagent`. Confidence 75% (up from 70 — shape now measured).

- [ ] **3.5 Split `run.ts` into crawl + match loops.**
  - User scan → stage-1 filter over the pool (in-process, ms over ~30k) → classifier on ~200 → deep score ~40.
    `jobs` becomes the per-user **materialized match view**; `isNew`/`firstSeen`/`dedupeKey` semantics preserved.
  - **`TOP_N_CANDIDATES` is 30 (`run.ts:34`) but the design says ~40** — conscious operator bump or leave at 30? Decide in-task.
  - Test must pass: existing `run.test.ts` green; determinism test still holds; a pool posting passing stage-1 is
    admitted to that user's `jobs` exactly once.
  - Files: `src/server/search/run.ts` (+ test).
  - `model:opus` `effort:xhigh` `@general-purpose` `exec:session` — highest-blast-radius refactor. Confidence 70%.

- [ ] **3.6 OPERATOR: staged rollout.**
  - `crawl:once` over the ramp set → real scan per persona → flip the validated list in ~250-source batches.
    JobStreet cap unchanged. Any 403/429 = stop.
  - `exec:session`.

### Track 4 — Connectors. **After the pool (Track P).** Order per D6 (amended 2026-07-17, DECISION B —
merged build order from `reports/2026-07-17-handoff-integration.md` §1): **Workable → Personio →
Teamtailor → Recruitee → Pinpoint → Rippling (conditional)**; SmartRecruiters stays **DROPPED**. Each:
build from the captured fixture; live-verified already.

- [ ] **4.0 Engine enrollment (per-vendor rider — every 4.x task below must satisfy this for its vendor).**
  The engine pipeline is **closed to greenhouse/lever/ashby**: `JOBHIVE_ALLOWED_FILES`
  (`src/server/sources/engine.ts:206`, test-pinned by `engine.test.ts:259` "only greenhouse/lever/ashby
  CSVs are ingested"), the closed `JobhiveAts` union + per-vendor URL regex (`jobhive.ts:15`),
  `connector: JobhiveAts` + `ID_PREFIX` (`seedFromEngine.ts:26,55`), `ATS_KINDS`
  (`freshness.ts:69`), and identity, which is per-vendor with no generic fallback (`identity.ts`).
  **Without this landing for a vendor, that vendor's connector is dead code** — built + registered,
  zero sources reachable through the engine. This is a **per-vendor checklist, not a one-time task**:
  it runs once per vendor as that vendor lands (4.1 must satisfy it for Workable, 4.2 for Personio, and
  so on) — each vendor task below says so explicitly rather than assuming this block covers all five.
  - Per vendor: extend `JOBHIVE_ALLOWED_FILES` with its CSV; extend the `JobhiveAts` union + add its
    URL-signature regex; add its `ID_PREFIX` entry + `connector` key in `seedFromEngine.ts`; add it to
    `ATS_KINDS` in `freshness.ts`; add its identity method — or, where the vendor exposes no identity
    signal, state an explicit `unverifiable` posture in-task (**Pinpoint's payload has no company field
    at all**; company comes from the source row, not the vendor API, so its identity posture must be
    stated, not silently assumed).
  - Test must pass: the vendor's CSV ingests through the engine (allowlist test **updated, not
    weakened** — still asserts the closed set, now including the new vendor); a slug seeds with the
    correct id prefix; `freshness.ts` recognizes the new ATS kind; identity returns a defined verdict
    (`confirmed` / `mismatch` / `unverifiable` — never falls through undefined).
  - Files: `src/server/sources/engine.ts`, `jobhive.ts`, `seedFromEngine.ts`, `freshness.ts`,
    `identity.ts` (+ tests) — one vendor's worth of edits per landing, not all five at once.
  - `model:sonnet` `effort:xhigh` `@general-purpose` `exec:subagent`. Confidence 80%.
- [ ] **4.1 Workable.** `apply.workable.com/api/v1/widget/accounts/{slug}?details=true` — no auth, no pagination
  (1,572 jobs in one call, verified), `telecommuting` bool = remote signal, `shortcode` = externalId,
  `published_on` = postedAt. Emit `department` into `RawPosting.department` (P.4's classifier input —
  without it the classifier silently degrades to title-only for this vendor). Satisfies **4.0** for
  Workable (allowlist / `JobhiveAts` / `ID_PREFIX` / `ATS_KINDS` / identity). **4,269 slugs.**
  Fixture: `__fixtures__/live-verify/workable.json`.
  - Test must pass: the **base list has no `description`** — `?details=true` is mandatory, and a test
    must assert a bare-list fixture (no `details=true`) is rejected/incomplete, not silently accepted;
    `?details=true` on a large board is multi-MB (nuvei's 57 jobs = 343 KB) — decide stream-or-cap
    in-task and pin the decision as a test, don't buffer unbounded; `application_url`→`applyUrl`;
    `published_on` is **date-only** (`"2026-06-27"`, no time component — don't assume a timestamp).
  - `model:sonnet` `effort:xhigh` `@general-purpose` `exec:subagent`. Confidence 85%.
- [ ] **4.2 Personio.** `{slug}.jobs.personio.com/xml?language=en` — XML (parser cost), `createdAt` = postedAt,
  remote in office string, **URL absent from XML** — pattern `{slug}.jobs.personio.com/job/{id}` live-verified 200.
  Emit `department`/`occupationCategory` into `RawPosting.department` (P.4's classifier input — without
  it the classifier silently degrades to title-only for this vendor). Satisfies **4.0** for Personio
  (allowlist / `JobhiveAts` / `ID_PREFIX` / `ATS_KINDS` / identity). **2,463 slugs.** Fixture: `personio.xml`.
  - Test must pass: dead slugs **307-redirect to `personio.com`, not 404** — validation must treat a
    redirect to the vendor's marketing domain as dead, not follow it as a live slug (the enpal case);
    `occupationCategory` (e.g. `sales_and_business_development`) is a free function signal, wire it
    alongside `department`; `subcompany` maps company when present, else the source row. **Make the
    XML-parser choice explicit** (`fast-xml-parser` vs hand-rolled) — the report reserves this decision
    for the operator; an `exec:subagent` must not silently add a dependency. This choice binds 4.3b's
    RSS parsing too — decide once, cite it there.
  - `model:sonnet` `effort:xhigh` `exec:subagent`. Confidence 80%.
- [ ] **4.3a Per-tenant crawl-permission gate.** (D5, generalized 2026-07-17 — see
  `reports/2026-07-17-handoff-integration.md` §2) Was "per-board robots gate"; too narrow for the vendors it
  now gates. Reusable: fetch `{board}/robots.txt`, parse (a) path allow/deny rules for the endpoint path AND
  (b) the `Content-Signal` directive's `ai-input` field — a line *inside* robots.txt that a path-only parser
  would wrongly pass (Teamtailor's polestar tenant: `/jobs.rss` path-open, but `Content-Signal: search=no,
  ai-train=no, ai-input=no` — must still be skipped, since Caliber feeds JD text to an LLM scoring pipeline,
  the `ai-input` class); record the verdict in `config`; **evaluated at crawl time every run**, not only at
  seed/validation time (a tenant can flip to `Disallow: /` or `ai-input=no` at any time). Gates **4.3b
  Teamtailor** (Content-Signal) and **4.4 Recruitee** (robots path). Test: path-allow + Content-Signal
  `ai-input=yes` → crawl; path `Disallow: /` → skip + marked; path-open but `ai-input=no` → skip + marked
  (the polestar case); unreachable robots → decide + justify (do NOT default to allow); re-evaluated per
  crawl run, not cached past one run.
  - Files: `src/server/sources/crawlPermission.ts` (+ test). Integration point: Track P's P.3 crawler
    seam note names "this task's per-source fetch loop" as the enforcement point
    (`docs/superpowers/plans/2026-07-17-global-postings-pool-build.md` P.3) — this task builds the gate,
    that per-source fetch loop is where it must be called; name it explicitly, don't leave the seam
    half-owned.
  `model:opus` `effort:xhigh` `@general-purpose` `exec:subagent` — legal-boundary logic. Confidence 80%.
- [ ] **4.3b Teamtailor.** _(NEW — added 2026-07-17, `reports/2026-07-17-rippling-pinpoint-teamtailor-live-verification.md`)_
  `{slug}.teamtailor.com/jobs.rss` — RSS/XML (parser cost shared with 4.2's XML decision), no auth, inline
  full-HTML description (no N+1), `pubDate` = postedAt, `remoteStatus` remote signal (`fully`→remote,
  `hybrid`→hybrid, others unknown), structured location via `tt:location`/`tt:department`/`tt:role`
  namespace, dedupe key = `guid` (per-location item expansion: one posting in N cities = N items, same
  title, distinct `guid`/`link`). Breadth RESOLVED live (polestar/luminorbank/paysend/unobravo — full board,
  all functions). **1,010 slugs** (jobhive `teamtailor.csv`, MIT) — **third of the five** (Workable 4,269
  > Personio 2,463 > Teamtailor 1,010; the report's "second-largest" was of its own three vendors —
  Rippling/Pinpoint/Teamtailor — not of all five new vendors). **Gated on 4.3a** (per-tenant Content-Signal
  `ai-input` check — polestar declares `ai-input=no` and must be skipped even though its RSS path is
  open). Custom-career-domain caveat: some tenants' `link` resolves off the `{slug}.teamtailor.com` host.
  RSS vendor-documentation status UNKNOWN (not checked in the verification pass). Emit `tt:department`
  into `RawPosting.department` (P.4's classifier input — without it the classifier silently degrades to
  title-only for this vendor). Satisfies **4.0** for Teamtailor (allowlist / `JobhiveAts` / `ID_PREFIX` /
  `ATS_KINDS` / identity).
  - **Step 1: capture + commit `src/server/search/connectors/__fixtures__/live-verify/teamtailor.rss`**
    (one polite RSS fetch against a live tenant) — **no fixture exists yet**: session-B's captures were
    scratchpad-ephemeral and are gone. Then build the connector from it.
  - Test must pass: the captured fixture parses into ≥1 `RawPosting` with `guid` as dedupe key,
    `pubDate`→postedAt, `remoteStatus` mapped per the fully/hybrid/unknown rule, `tt:department`
    populated; validation requires **≥1 RSS item** — a zombie-board feed can return 200 with a valid-empty
    `<channel>` (funnel: 0 items) and must be treated as empty, not an error, while a dead slug 404s
    (worldbank) and must be treated as unreachable, not empty; 4.3a gate integration (a polestar-shaped
    `ai-input=no` tenant is skipped even with an open RSS path).
  - Files: `src/server/search/connectors/teamtailor.ts` (+ test), the fixture above.
  - `model:sonnet` `effort:xhigh` `@general-purpose` `exec:subagent`. Confidence **75%** (down from 80 —
    no fixture exists yet, and RSS vendor-documentation status is UNKNOWN).
- [ ] **4.4 Recruitee.** `{slug}.recruitee.com/api/offers/` — no auth, `remote/hybrid/on_site` bools, `published_at`,
  description in list (best payload of the five). Emit `department` into `RawPosting.department` (P.4's
  classifier input — without it the classifier silently degrades to title-only for this vendor). Satisfies
  **4.0** for Recruitee (allowlist / `JobhiveAts` / `ID_PREFIX` / `ATS_KINDS` / identity). **Gated on
  4.3a.** 888 slugs; CSV contains zombie boards. Fixture: `recruitee.json`.
  - Test must pass: `published_at` is **non-ISO** (`"2026-07-02 17:18:08 UTC"`) — `Date.parse` is not
    guaranteed to accept this format; parse it explicitly and pin a test on the literal string; `salary`
    numerics are **string-typed** (verified in the fixture: `{min: "92000", max: "120000", ...}`, not
    numbers) → map into `salaryRaw` as-is, do not silently coerce; concatenate the separate `requirements`
    field (HTML, distinct from `description`) rather than dropping it.
  - `model:sonnet` `effort:xhigh` `exec:subagent`. Confidence 80%.
- [ ] **4.5 Pinpoint.** `{slug}.pinpointhq.com/postings.json` — no auth, `workplace_type` = remote signal.
  **No postedAt exists** (docs confirm) → fallback is pool `firstSeenAt`, so this **requires the pool
  (Track P)**. Emit `job.department.name` into `RawPosting.department` (P.4's classifier input — without
  it the classifier silently degrades to title-only for this vendor). Satisfies **4.0** for Pinpoint —
  **the payload has no company field at all**, at any level; company comes from the source row only, so
  identity must post an explicit `unverifiable` posture, not a silent skip. 350 slugs; trilongroup
  returned exactly 1,000 rows — possible silent cap, UNKNOWN (re-observed twice). Fixture: `pinpoint.json`.
  - Test must pass: `url` contains an **`/en/` locale segment**
    (`{slug}.pinpointhq.com/en/postings/{uuid}`) — treat the whole `url` as opaque, do not parse or strip
    the locale; **no company field anywhere in the payload** — a test must assert the connector never
    invents or defaults a company, it only reads the source row.
  - `model:sonnet` `effort:high` `exec:subagent`. Confidence 75%.
- [ ] **4.6 Rippling — CONDITIONAL.** _(amended 2026-07-17, DECISION B — moved last of the built set, was 3rd
  under old D6; see `reports/2026-07-17-handoff-integration.md` §1)_ `ats.rippling.com/api/v2/board/{slug}/jobs`
  — **paginated** (`page/pageSize/totalItems/totalPages`), list lacks description/date/company →
  **`fetchDetail` required** (N+1, scoring-time only). Undocumented = fragile. Emit `department{name}`
  into `RawPosting.department` (P.4's classifier input — without it the classifier silently degrades to
  title-only for this vendor). Satisfies **4.0** for Rippling (allowlist / `JobhiveAts` / `ID_PREFIX` /
  `ATS_KINDS` / identity). **1,923 slugs.**
  **New info post-D6: governing ToS is undiscoverable** — `www.rippling.com/terms`,
  `/legal/terms-of-service`, `/legal/website-terms-of-use` all 404; no public terms document governing
  `ats.rippling.com` could be located. §7 class: **Grey** (no explicit prohibition, unlike Getro/
  SmartRecruiters). **Build only after the operator explicitly records acceptance of the ToS-blank +
  fragility** (this session gate) — mechanics are twice-verified and ready; the block is legal posture, not
  technical. `consecutiveFailures` containment + scoring-time-only N+1 stand as designed.
  - **`fetchDetail` signature gap**: the shared `SourceConnector.fetchDetail` contract
    (`src/server/search/connector.ts:65`) returns only `Promise<{description: string; applyUrl?: string}>`
    — detail-sourced `createdOn`/`companyName` **cannot flow through it as-is**. Decide explicitly,
    in-task: either (a) extend the signature to carry them (state plainly that this is a contract-surface
    change touching every connector implementing it), or (b) drop detail-sourced postedAt/company for
    Rippling and rely on pool `firstSeenAt` + the source row instead. Do not leave this implied.
  - Test must pass: `page` is **zero-indexed** (default response echoes `page: 0`) — a test pinning the
    first page request as `page=0`, not `page=1`; `description` from `fetchDetail` is an **object keyed
    by section** (observed `{company, role}`), not a string — concatenate sections into a single
    `description`, don't pass the object through raw.
  Fixtures: `rippling.json` + `rippling-detail.json`. `model:sonnet` `effort:xhigh` `exec:subagent`.
  Confidence 70% (mechanics); operator go required before build.
- [x] **4.7 SmartRecruiters — DROPPED (final).** `api.smartrecruiters.com/robots.txt`: `User-agent: LinkedInBot / Allow: /v1/companies/`,
  then `User-agent: * / Disallow: /`. An explicit allowlist we are not on. API never called. Not a judgment
  call. See `docs/superpowers/reports/2026-07-17-smartrecruiters-verification.md` — governing SAP API
  Policy §2.2.2/§3 independently prohibits this class of access regardless of the robots signal.

## Risks & uncertainties

- **Dataset vendoring — RESOLVED (D8, 2026-07-17): fetch yc-oss at runtime, do not vendor.** It has no LICENSE
  (`license: null`), so fetching sidesteps redistribution entirely. Consequence for 0.3: the engine needs network
  for the niche-list stage, and a fetch failure must fail loud (no stale-cache fallback). jobhive (MIT) and
  remoteintech (ISC) are safe to vendor if a cache is wanted later — not now.
- **The 90-min dry run may not reproduce ~861.** That number is measured from the datasets, but the *validate* stage
  has never run — live 200-rate is UNKNOWN. Expect the seedable count to be lower.
- **Pool sizing under D2 — MEASURED 2026-07-17, not a risk.** Real JDs average **4,289 chars** (Stripe greenhouse,
  n=526: median 4,110, p99 7,752, max 9,580, **0% over the 40k cap**). Projection: 30k postings ≈ **0.12 GB**;
  300k/year ≈ 1.15 GB. SQLite's ceiling is 281 TB — storage is a non-issue and D2 is cheaper than first priced.
  **The real constraint is the query pattern**: stage-1 filtering must never `SELECT description` (it would drag
  ~120 MB/scan for a column it doesn't read) — only the ~40 deep-scored rows fetch it. Pin this in 3.1/3.5 as a
  test, not a comment.
- **libsql single-writer** binds 3.2's write shape; main's `no-db-transaction.test.ts` now enforces it repo-wide.
- **Matching residue** (synonymy/morphology) is real and lands in 3.4 — recall 0.722 is not the ceiling, but thresholds
  can't lift it further; the stress test measured that.
- **Rippling's undocumented surface** can change without notice; `fetchDetail` N+1 must stay scoring-time-only.
- **Legal**: JobStreet capped/local-only; Getro out (ToS); SmartRecruiters out (robots); topstartups out (403);
  Recruitee per-tenant (gate 4.3a; task 4.4). Any 403/429 is a stop signal, never a thing to route around.

## Out of scope

- Wellfound/LinkedIn/Indeed/Glassdoor; any paid feed; Getro/Consider scrapers.
- A user-facing source picker (sources stay admin-managed reference data).
- Full JD mirroring in the **UI** — excerpt + link-out remains the display posture (this is what D2 relies on).
- Fixing synonymy/morphology by threshold tuning — measured dead end; it's 3.4's job.

## Models & execution

- `model:` — `opus` = fuzzy judgment / core-correctness / architecture; `sonnet` = default build.
- `effort:` — per CLAUDE.md Effort Policy: `low` one-line/lookup; `medium` routine edits/codegen;
  `high` analysis/review; `xhigh` hard/multi-file/agentic. Pass explicitly when spawning subagents.
- `exec:` — `subagent` = autonomous, test-gated via `/continue-handoff`; `session` = operator in loop.
- Per-task gate: `npm test`. Merge gate: `npm run check`.
- **Real-data rule**: any task touching matching or ingestion validates against `live-titles.json` or the real
  datasets — never fixtures alone. This program has been burned three times.
