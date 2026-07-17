# Operational Layer + Debt — Build Plan (Track O)

Closes the operational gaps the source engine left open (source health self-sustains) and the small
debt accrued this session. One plan, two sections; every task rides shipped Phase 2 infrastructure, so
**all of Track O is buildable NOW, independent of the pool (Track P)** — and arguably more urgent, since
it keeps the 803 seeded sources healthy and growing while the pool is built. Written 2026-07-17.

## Context

- 803 engine-seeded sources live in `caliber.db` (Phase 2, merged). Their health loop
  (`runFreshnessPass`, `freshness.ts:304`) and the growth funnel (`sources:engine` chain) EXIST but
  **nothing schedules or consumes them** — a dead slug never heals, a new YC company never gets seeded,
  and a disabled source is invisible.
- Reconciliation flag: **O.1 (freshness) overlaps the pool crawler (Track P / P.3)** — the crawler's
  delist sweep touches source health too. They are complementary today (freshness = source
  re-detection/healing; crawl = posting ingestion), but when P.3 lands, revisit whether the crawler
  subsumes freshness's revalidation half, leaving freshness for ATS re-detection only. Noted, not blocking.

## Section A — Track O (operational). ~3–5 days. Fully parallelizable; independent of the pool.

- [ ] **O.1 Freshness CLI + weekly schedule.**
  Goal: the existing `runFreshnessPass` (`freshness.ts:304`) runs on a weekly cron so dead slugs heal or
  are visibly disabled (never silently 404 forever).
  - Add a CLI wrapper `sources:freshness` (mirror `sources:engine`'s shape — injected fetch/clock at the
    boundary, `--env-file-if-exists`, a `--report=<path>` flag with a sensible default). Signature verified:
    `runFreshnessPass({repo, fetch, now?})`; the real `sourcesRepo` already satisfies `FreshnessRepo`
    (`listAll` + `update`, `repos/sources.ts:43,58`).
  - **There is NO dry-run mode** and none is in scope — every pass writes `repo.update`. Emit a **run
    summary** of `FreshnessOutcome[]` counts (not a "dry" report).
  - **Must catch `FreshnessPassError` specially** (`freshness.ts:124-137`): partial outcomes ride ON the
    error, so a plain `.catch(console.error)` would discard the summary of the ~800 rows that DID process.
    Print partial outcomes + failures, then exit non-zero.
  - The cron is a VPS-box operator step — deliver the script + the exact crontab line, **with `flock -n`**
    for overlap protection (a full lease like the url-check worker is overkill at weekly cadence).
  - Test must pass: the CLI invokes `runFreshnessPass` and exits non-zero on failure; a `FreshnessPassError`
    still prints the partial run summary (this is the regression that matters); existing `freshness.test.ts` green.
  - Files: `src/server/sources/freshness-run.ts` (+ test), `package.json`.
  - `model:sonnet` `effort:medium` `@general-purpose` `exec:subagent` — CLI wrapper over shipped logic. Confidence 90%.

- [ ] **O.2 Admin surface — source health / dead sources.**
  Goal: §4.3's requirement — dead/disabled sources are "visibly disabled with a count on an admin surface."
  - Extend the existing admin area (`src/app/(app)/admin/page.tsx` + `src/app/api/admin`) with a sources
    health view: total/enabled/dead counts, and a list of `status:'dead'` / `enabled:false` rows with
    `consecutiveFailures`, `lastValidatedAt`, `jobCount`, provenance. Read-only v1.
  - Mirror the verified existing pattern: client page + `features/admin/client` + `/api/admin/users` route
    + `page.test.tsx` with `vi.mock`.
  - **PINNED (do not decide these yourself):**
    1. **Health aggregates = JS aggregation over `listAll()` (~850 rows) in the API route. NO migration.**
       Health fields live inside the JSON `config` column; the spec's "promote to columns when the admin UI
       needs them" is **consciously deferred** — do not write a migration for this task.
    2. **Partition engine rows vs hand-curated rows.** Only engine-seeded rows have health fields (they're
       the ones with `provenance` — `freshness.ts:164`); curated seed rows legitimately have none. Show
       curated rows without health fields; do NOT fail-loud on their absence.
  - Note: the existing sources page toggle can already flip `enabled` but does NOT reset `status:'dead'`/
    `consecutiveFailures` — so "no re-enable action" is the accurate deferral (a healed re-enable is follow-up).
  - Test must pass: the API returns correct health aggregates from seeded rows (incl. a dead fixture AND a
    curated row with no health fields); the page renders the count + list (dom test, mirror existing tests).
  - Files: `src/app/(app)/admin/…`, `src/app/api/admin/…` (+ tests). No `repos/sources.ts` query needed
    (`listAll` suffices).
  - `model:sonnet` `effort:high` `@general-purpose` `exec:subagent` — UI + data; operator does visual QA. Confidence 80%.

- [ ] **O.3 Growth-loop consumer — daily yc-oss diff → engine → seed.**
  Goal: new YC companies get discovered and seeded automatically — the local persona's path off a static list.
  - New `sources:growth` script. **Exact endpoint (verified live 2026-07-17 — the obvious guess 404s):**
    `https://yc-oss.github.io/api/changes/latest.json` — **NOT** `…/api/companies/changes/latest.json` (404).
    Payload shape: `{generated_at, summary:{previous_total, current_total, added, removed, updated}, added[],
    removed[], updated[]}` — the totals are nested under `summary`, not top-level. `added[]` entries carry
    `name`/`website`/`isHiring`, so **`parseYcOss(payload.added)` works verbatim** (`nicheList.ts:75` requires
    boolean `isHiring` — present).
  - **jobhive IS fetched every run** (this is not optional): `matchNicheToJobhive(niche, jobhive)`
    (`nicheFilter.ts:174`) needs the full ~9.9k-row jobhive set to match against. The plumbing
    (`fetchJobhive`, `listGithubDir`, `fetchOk`, `mapLimit`, `JOBHIVE_ALLOWED_FILES` — `engine.ts:144-220`)
    is **module-private to engine.ts**: either export `fetchJobhive` (one-line change, preferred) or
    duplicate ~60 lines. **This is the unstated dependency — name it, don't discover it.** Also reuse
    `seedFromEngine`'s id mapping `${ID_PREFIX[ats]}:${slug}` (`seedFromEngine.ts:54-58,86`) for the id-skip.
  - Run ONLY the added companies through the chain (match → identity → validate → seed), **deduping against
    already-seeded ids up front** (`bulkInsert`'s `onConflictDoNothing` is the backstop, not the plan).
    **Do NOT fetch yc-oss `all.json`** (that's the 6,050 full list — the thing we're avoiding).
  - **Politeness (design §7, binding):** the engine's host-stop logic lives in the private `runStage` and is
    NOT reused here. At N≈7 added/day, the sufficient policy is: **any 403/429 aborts the pass, fail loud.**
    State it in code, don't improvise.
  - **Gap-day risk:** `latest.json` covers only the MOST RECENT diff — a missed cron day loses those
    additions permanently. Backstop: an occasional full `sources:engine --seed` (idempotent via
    `onConflictDoNothing`, `repos/sources.ts:22`). Document this in the crontab note.
  - Reuses the exported stage functions (`parseYcOss`, `matchNicheToJobhive`, `verifyIdentity`,
    `validateSlugs`, `seedFromEngine`) — all work on subsets, **no `runEngine` refactor needed** (verified).
    ~25 lines of gating glue get duplicated from `engine.ts:434-506`; acceptable.
  - Test must pass: a fixture diff of N added companies → only those run the chain; **yc-oss `all.json` is
    never fetched** (jobhive IS — assert accordingly); already-seeded ids are skipped; only
    identity-confirmed + validated new rows seed; an empty diff is a clean no-op; a 403/429 aborts loudly.
  - Files: `src/server/sources/growth.ts` (+ test), `engine.ts` (export `fetchJobhive` only), `package.json`, crontab note.
  - `model:sonnet` `effort:xhigh` `@general-purpose` `exec:subagent` — diff-driver over the specified engine chain. Confidence 80% (with the above pinned; was ~65% as originally written).

## Section B — Debt. ~half a day. Independent one-offs; do first as a warm-up (fast, clears the tree).

- [ ] **D.1 Fix `eligibility-distribution.ts:13` libsql incompatibility.**
  Goal: `npm run eligibility:report` runs on libsql (currently errors — the last `count(*)::int` in `src/`).
  - Replace `count(*)::int` → `count(*)` (mirror the exact fix `4f5ad11` applied to `remote-fit-coverage.ts`).
    Verify via grep that this is the ONLY remaining `::int` in `src/`.
  - Test must pass: the script runs against a seeded test DB without a `SQLITE_ERROR`; if no test exists,
    a minimal one asserting the query executes.
  - Files: `src/server/score/eligibility-distribution.ts` (+ minimal test if warranted).
  - `model:sonnet` `effort:low` `@general-purpose` `exec:subagent`. Confidence 95%.

- [ ] **D.2 Doc-consistency sweep.**
  Goal: the docs read as internally consistent after this session's many edits.
  - Design spec `2026-07-16-…`: fix the stale §3 "SmartRecruiters hit-rate / thin-sample" line (`:91-92`)
    and the §6 connector-order text (`:451-453`, should match the merged D6 order); bump the jobhive totals
    to include teamtailor.csv. **Recompute the totals from the live CSVs and cite the source — do NOT paste
    a number from this plan.** (An earlier draft said "~10,903 / ~20.8k"; that does not reconcile with the
    spec's own figures — 9,935 + 1,010 = 10,945, and 19,214 + 1,010 ≈ 20.2k. Count, don't guess.)
  - Ignition plan `2026-07-17-source-engine-ignition.md`: mark the superseded Track 3 (3.1–3.6) body text
    as "SUPERSEDED by Track P" (a header note is not enough — a reader hits the stale tasks).
  - **Remote-fit spec `2026-07-14-remote-fit-criteria-design.md` — six sections invalidated by DECISION A**
    (full soft rank, 2026-07-17, shipped in `b5d244a`). All now FALSE and must be corrected:
    §1 (:8) "provable mismatches are hidden before the user ever sees them"; §2.1 (:12) "only *provably*
    restricted jobs are hidden"; §2.5 (:16) "Employment structure ships as a dial with a stated-only hard
    gate… → hidden"; §5 (:64) "a job with no band is never hidden by the schedule gate" (implies the gate
    hides); **§7 "Feed behaviour" (:76-88) — the gate table (:80-84) and ":86 `stats.excluded` counts all
    three gates" is the core stale artifact**; §10 (:116) the e2e test-plan line ("a US-hours job leaves
    the feed"). Correct each to rank-not-hide; the **relocation `stay`/abroad gate remains hard** — do not
    over-correct it. Note: the widely-cited "§8" does not exist — the gate table is **§7**; fix that
    reference where it appears.
  - Doc-only; no test. Acceptance: a diff review shows the inconsistencies resolved, nothing else touched.
  - Files: the three docs above.
  - `model:sonnet` `effort:low` `@general-purpose` `exec:subagent`. Confidence 90%.

## Sequencing

- **Debt (D.1, D.2) first** — fast, independent, clears the tree.
- **Track O (O.1, O.2, O.3) fully parallel** — all three ride shipped Phase 2 infra, touch disjoint files
  (freshness / admin / growth), and don't depend on each other or the pool. Can run as one wave.
- Reconcile O.1 with P.3 when the pool crawler lands (see Context).

## Risks

- **O.1/P.3 overlap** — building the freshness cron now then reworking it when the crawler subsumes part of
  it. Accepted (Fable-reviewed): `freshness.ts` exists regardless, O.1 is a ~1-day CLI wrapper, and the
  eventual rework is at the CLI/cron layer only. Not wasted work.
- **O.3 dedup correctness** — re-seeding an existing company would create a duplicate source; the id-skip +
  `onConflictDoNothing` are two guards, tested both ways.
- **O.3 gap-day** — `latest.json` is a single most-recent diff; a missed cron day loses those additions
  permanently. Backstop: occasional full `sources:engine --seed` (idempotent). Documented in the task.
- **O.3's jobhive dependency was nearly missed** — the original draft omitted it and its test criterion would
  have actively misled the builder ("assert the full list is never fetched" — jobhive MUST be fetched).
  Caught by review; the corrected criterion is "yc-oss `all.json` never fetched". Kept here as the record of
  why plans get reviewed against real code.
- **O.2 no re-enable action** — v1 is read-only visibility; a healed/manual re-enable button is a follow-up,
  called out so it's a conscious deferral not an omission.

## Models & execution

- `model:` sonnet throughout (CLI wrappers, a diff-driver over specified logic, admin UI, one-line fixes —
  all "Sonnet = building" per CLAUDE.md; nothing here is architecture or fuzzy core-correctness).
- `effort:` low for the debt one-offs, medium/high/xhigh for the operational builds per the CLAUDE.md table.
- `exec:` all `subagent` (test-gated); the cron/crontab lines are operator VPS steps delivered as notes,
  and O.2's visual QA is an operator glance — neither makes the task `session`.
- Per-task gate `npm test`; merge gate `npm run check`. Build in an isolated worktree.
