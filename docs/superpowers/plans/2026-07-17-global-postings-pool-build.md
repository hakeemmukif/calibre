# Global Postings Pool — Build Plan (Track 3 execution)

Executes `docs/superpowers/specs/2026-07-17-global-postings-pool-architecture.md` (operator-approved
2026-07-17). Supersedes Track 3 (3.1–3.6) of `2026-07-17-source-engine-ignition.md` with the
architecture doc's resolved decisions. Written 2026-07-17.

## Goal

Crawl all 819 enabled boards once nightly into a shared `postings` table; user scans read the pool
(ms, local) instead of re-fetching every board per scan. The pool is the fix for the per-user
fan-out wall — not source ramp-down.

## Operator decisions (binding)

- **No interim bridge ramp-down.** Scans stay slow (~10–20 min at 819 sources) for the ~1.5–2 weeks
  until cutover; the pool is the real fix. Do NOT disable sources.
- D2 (prior): pool stores **full JD text** at crawl time (measured ~4,289 chars avg, ~0.12 GB @ 30k).
- Query-pattern constraint: stage-1 matching NEVER selects `description` — pinned as a test, not a comment.
- libsql `file:` is single-writer, forbids concurrent `db.transaction` (main's `no-db-transaction.test.ts`
  guards it) — crawler writes are small sequential single-row upserts.

## DECISION A (operator, 2026-07-17) — full soft rank, hide nothing

tz_band, scheduleFlex, **and** employmentPref all demote/rank; **nothing is hard-gated or hidden**.
Maximum visibility, fit-sorted — every admitted job is shown to every user, ranked by fit. This overrides
the handoff-integration report's floated "gate structural (employmentPref), rank soft (tz)" split and
absorbs its open item #4 — the gate-vs-rank collision spanning `run.ts:555-560` (inside P.5's blast
radius) and `jobsFeed.ts:68-69` (outside it); see
`docs/superpowers/reports/2026-07-17-handoff-integration.md` §4. P.5 below is written to this decision.

## Prerequisite — SATISFIED (`4f5ad11`, 2026-07-17)

- **`tzBand.ts` reconciliation — RESOLVED.** The place-name tz-band map committed as `4f5ad11` is the
  shared dependency the pool consumes, not a competing definition: the crawler stamps `postings.tzBand`
  by calling `resolveTzBand(location)` (profile-INdependent). Fable review confirmed coherent, 144/144
  score tests pass. **P.5 is unblocked.**

## Department provenance — a cross-task dependency the pipeline does NOT yet satisfy

P.4's function tag is "dept-mapped, title fallback" — but the department string is **dropped at the
connector boundary**: `RawPosting` (`connector.ts:17-31`) has no `department` field, and ashby/greenhouse/
lever never read one. The dept measurement was against vendor APIs directly, not the code path. So the
plumbing must be built and owned explicitly: **P.1** adds a `department` column to `postings`; the
**connector work** (add `department?` to `RawPosting` + the three ATS connectors) rides P.3's crawler
task; **P.4** consumes only. Without this, P.4 has no input.

## Tasks

Legend: `model:` · `effort:` (CLAUDE.md policy) · `@agent` · `exec:` subagent (autonomous, test-gated) or
session (operator in loop). Per-task gate: `npm test`. Merge gate: `npm run check`. Sequence matters.

### Track P — the pool. ~1.5–2 weeks.

- [ ] **P.1 Schema + repo (keystone).** _(arch §1; was 3.1)_
  Goal: net-new global `postings` (no `userId`; full `description`; `canonicalKey` UNIQUE; `tzBand`,
  `functionTag`, **`functionTagVersion`**, **`department`** columns; `firstSeenAt`/`lastSeenAt`) +
  `crawl_runs` (arch §7.2) + `jobs.posting_id` nullable `ON DELETE SET NULL`. `repos/postings.ts` with a
  **closed `listForMatching` projection that structurally omits `description`** (but includes `department`
  — a short string, no read-amplification) + `getForScoring(ids)` that includes `description` +
  **`setFunctionTag(id, tag, version)`** (P.4's write-back, provisioned now so P.4 needs no second migration).
  - **Pre-provision P.4's schema needs now** (`functionTagVersion` + `setFunctionTag`) — arch's "schema is
    hard to walk back" is exactly why P.4's columns land in P.1, not mid-track.
  - Test must pass: migration applies cleanly to a copy of the live DB, additive-only confirmed by diff
    (drizzle is forward-only — no "down"); `listForMatching` query text asserts `description` absent
    (arch §1.2 constraint as a test) and `department` present; `canonicalKey` uniqueness;
    **`no-db-transaction.test.ts` stays green**; existing `jobs` tests green.
  - Files: `schema.ts`, migration, `repos/postings.ts` (+ tests). Contract: no `Posting` Zod entity yet
    (arch §7 — only when an admin page ships).
  - `model:opus` `effort:xhigh` `@general-purpose` `exec:session` — schema is hard to walk back. Confidence 85%.

- [ ] **P.2 Global dedupe module.** _(arch §4; was 3.3 — build BEFORE the crawler that calls it)_
  Goal: **pure functions only** (no DB — alias-merge writes belong to P.3's crawler): `canonicalKey`
  builder — primary `ats:{sourceId}:{externalId}` else normalized-URL; secondary cross-board key lifting
  the shipped `secondaryKey`/`resolveCanonicalCollision` (`dedupe.ts`) to crawl time; ATS-direct > board >
  aggregator ordering; location-bucket v1 (remote-keyword→`remote`, else city-before-comma, biased to
  under-merge).
  - Test must pass: same job from two boards → one canonical row, ATS-direct wins; re-crawl stability
    (same input → same key); location-bucket cases; under-merge (never data loss).
  - Files: `src/server/sources/dedupe-global.ts` (+ test).
  - `model:sonnet` `effort:xhigh` `@general-purpose` `exec:subagent` — arch §4 fully specifies the
    algorithm; this is implementation fidelity of a pure module (CLAUDE.md "Sonnet = building"). Confidence 80%.

- [ ] **P.3 Crawler + scheduler (+ connector `department`).** _(arch §2, §7; was 3.2)_
  Goal: `crawler.ts` — fetch-whole-board-then-write per source, **sequential single-row upserts** (no
  `db.transaction`), per-vendor-host limiter, stop-on-429 per host, per-source delist sweep gated on that
  source's fetch success, 60-day purge; **stamp `postings.tzBand` at crawl via `resolveTzBand(location)`**
  (arch §1.1 — profile-independent, so it belongs at crawl not admission); `crawl_runs` lease for overlap
  protection + writes the latest-successful-crawl fact to `crawl_runs` (the 48h staleness *surface* moves
  to P.5's scan SSE path); `crawl:once` script; VPS cron line (~03:00).
  - **Connector work** (P.4's dependency): add `department?` to `RawPosting` + read it in ashby/greenhouse/
    lever, carry into `postings.department`.
  - **Seam note**: the crawl-permission gate (robots + Content-Signal) is ignition task 4.4a, generalized —
    P.3 leaves the seam (this task's per-source fetch loop is the enforcement point when Track-4
    tenant-hosted vendors ride it) but does not build the gate now; the current three vendors don't need it.
  - Test must pass: write-interleave test (crawler writes while a user scan writes — no `SQLITE_BUSY`);
    a failing source doesn't abort the crawl; delist only after that source's fetch succeeds; 429 stops
    one host, others continue; lease prevents overlapping runs; **60-day purge hard-deletes and
    `jobs.posting_id` SET NULL survives (user row intact)**; `tzBand`/`department` stamped from a fixture.
  - Files: `src/server/sources/crawler.ts` (+ test), `connector.ts`, the three connectors, `crawl:once`
    script, cron note.
  - `model:opus` `effort:xhigh` `@general-purpose` `exec:subagent` — libsql write-shape core-correctness
    (the landmine proven twice); cron/VPS wiring is an operator note. Confidence 75%.

- [ ] **P.4 Function tag + LLM classifier with write-back cache.** _(arch §3; was 3.4; tier study reshaped it)_
  Goal: coarse `functionTag` = **dept-mapped, title fallback** (measured: all postings carry a board
  dept string); `function-classify` LLM task (`client.ts` TaskName + `models.yml` block + `renderTemplate`,
  mirroring `correlate`) ONLY for the ~213 measured residue after 2b.1's synonym table; **cache the verdict
  on the posting** (crawl stays zero-LLM-cost; classifier runs scan-time, amortized) with a classifier-
  version re-tag gate. **JD text is stage-1 poison (1,673 FP measured) — classifier + deep-score inputs only.**
  - Depends on: 2b.1 (merged `a54177a`) which cut this load ~60%; **and P.1's `department` column + P.3's
    connector `department` plumbing** — the tag's primary input. P.4 consumes; it does NOT build the plumbing.
  - Test must pass: dept→function mapping over real `live-titles.json`; classifier fail-loud on emission
    drift (mirror `correlate`); write-back cache via `setFunctionTag` + `functionTagVersion` re-tag gate;
    measured band size + accuracy reported.
  - Files: `src/lib/llm/…` (client.ts TaskName + templates live here, NOT `src/server/llm`),
    `config/models.yml`, `src/server/sources/function.ts` (+ tests).
  - `model:sonnet` `effort:xhigh` `@general-purpose` `exec:subagent`. Confidence 75% (once dept plumbing lands).

- [ ] **P.5 run.ts split — the cutover.** _(arch §3, §5, §6; was 3.5 — highest blast radius)_
  Prerequisite SATISFIED (`4f5ad11`).
  Goal: replace the per-source discovery block with pool-read → stage-1 (`listForMatching`, no description)
  → classifier on survivors → deterministic rank → deep score (reads JD via `getForScoring`) → admit into
  per-user `jobs`; **admission stamps eligibility (tz_band/scheduleFlex/employmentPref) as a RANKING
  signal, NOT a gate — the scan must NOT pre-drop jobs on any eligibility signal** (DECISION A, full soft
  rank, 2026-07-17, above); **`tzBand` is read from the posting** (stamped at crawl by P.3, per arch §1.1 —
  NOT re-derived at admission) and demotes rank, it does not filter; `ensureDescription` posting-first;
  TOP_N stays 30; `isNew`/`firstSeen` admission-based (arch §5, verbatim `resolveIsNewCutoff`); **the 48h
  crawl-staleness fail-loud warning surfaces here on the scan SSE** (reads `crawl_runs`); **no eligibility
  hard-gate — all admitted jobs are shown, ranked by fit** (operator decision 2026-07-17, full soft rank).
  - Test must pass: existing `run.test.ts` + determinism test green; a pool posting passing stage-1 is
    admitted to that user's `jobs` exactly once; no `description` in the stage-1 path; JD reaches scoring;
    stale-crawl (>48h) emits the SSE warning; **no job is dropped pre-score on an eligibility signal —
    eligibility affects rank only.**
  - Files: `src/server/search/run.ts` (+ test).
  - `model:opus` `effort:xhigh` `@general-purpose` `exec:session` — highest blast radius. Confidence 70%.

- [ ] **P.6 Rollout (operator-owned).** _(arch §6; was 3.6)_
  Stage A: pool fills dark while fan-out still runs — soak pool count vs live ~18,288, crawl stats, busy-error
  grep. Stage B: one cutover commit (revertible). Stage C: delete fan-out. No bridge ramp-down (operator decision).
  - `model:n/a (operator-owned)` `effort:n/a` `exec:session`.

### Not in this plan (deferred)
- Admin crawl-health page + the `Posting` Zod contract entity (arch §7 — only when the page ships).
- Connectors (Track 4 of the ignition plan) — after the pool.
- The growth loop (yc-oss daily diff) — operational.

## Risks (from arch §9)

- **Vendor rate-limiting the nightly 479-GET Ashby sweep** — mitigated by stop-on-429 + 1×/day pacing (P.3).
- **Matcher residue over a 30k pool** — owned by 2b.1 (done) + P.4; the pool neither helps nor hurts recall,
  it makes misses cheaper to re-run.
- **Write-interleave regressions under real concurrency** — the P.3 interleave test + Stage-A soak with
  fan-out still live.
- **A hidden consumer of scan-time `jobs.description`** — P.5 keeps `ensureDescription`'s persist behavior;
  grep-audit consumers during P.5.
- **tzBand.ts collision with the uncommitted migration** — resolve before P.5 (prerequisite).

## Models & execution

- `model:` opus = schema/architecture/cutover; sonnet = the classifier build.
- `effort:` xhigh across the board (multi-file, schema, agentic) per CLAUDE.md.
- `exec:` P.1 and P.5 are `session` (schema + cutover, operator in loop); P.2/P.3/P.4 are `subagent`.
- Per-task gate `npm test`; merge gate `npm run check`.
- Build in an isolated worktree. The tzBand migration is resolved (`4f5ad11`); the tree is clean.
- P.4 may run in parallel with P.3 after P.1 (its dept input is provisioned in P.1/P.3), but is gated on
  the connector `department` plumbing landing in P.3.
