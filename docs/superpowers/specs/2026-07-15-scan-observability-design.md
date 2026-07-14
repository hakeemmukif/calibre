# Scan Observability — design spec

**Date:** 2026-07-15
**Status:** Approved design, pre-implementation
**Scope:** Make market scans observable — a verbose live view of the running pipeline, and a persistent Scans history tab. Plus a recorded decision on how similar résumés/personas pool jobs (no build).

---

## 1. Problem & context

A market scan is a black box today. Clicking **Scan now** on `/feed` opens a modal (`ScanProgress`) that collapses real work into a coarse 4-stage bar (`sources → fetch → score → legitimacy`). Underneath, the scan is doing far more — 8 concurrent source connectors, then the top ~30 jobs scored a few at a time, each running liveness → JD-fact extraction → match-scoring → (sometimes) escalation → legitimacy. None of that is visible, and when it finishes there is **no record**: `search_runs` keeps only a final box-score; the progress timeline is thrown away, and a run is never linked to the jobs it produced.

The operator wants three things:

1. **A verbose live view** — see the backend working, with the current life-status of each concurrent process, so a running scan is obviously *not stuck*.
2. **A Scans tab** — a place where every scan is listed and can be inspected: which résumé it used, how long it took, and what happened (before / during / after).
3. **Clarity on multi-résumé pooling** — if two similar résumés/personas scan, do they fetch/duplicate the same job? What is the source of truth?

This spec resolves thread 3 as a **decision** (§8) and builds threads 1 + 2 as one coherent feature.

---

## 2. Grounded facts (verified against code)

The plan must not re-derive these. All verified during design.

- **Trigger & stream.** `POST /api/search` (`src/app/api/search/route.ts`) returns `202` + `SearchRun(queued)`, then fires `runFanOut()` async (`src/server/search/run.ts`). Progress streams over SSE at `GET /api/search/:id` (`src/app/api/search/[id]/route.ts`), which emits `progress` / `job` / `done` / `error`, or returns a JSON snapshot if the request has no `text/event-stream` accept header. 15s heartbeat.
- **Stages.** `runFanOut`: **DISCOVER** (8 concurrent connectors via `pLimit`, `run.ts` `DEFAULT_CONCURRENCY`) → upsert jobs → **SCORE** top ~30 candidates, currently a **sequential batch loop of `Promise.all` over batches of 3** (`SCORE_BATCH_SIZE=3`, `run.ts:451-501`), *not* a rolling pool → a decorative "legitimacy complete" signal → `done`.
- **Per-job scoring** (`scoreJob`, `src/server/score/index.ts`): liveness → `extractJdFacts` (LLM) → `scoreMatch` (LLM, 20–36s, dominant cost) → **possible escalation** (a *second* full `scoreMatch` when confidence is low, `score/index.ts:79-86`) → legitimacy resolve (pure, instant) → upsert `job_scores` → emit `job`. **The scan path does NOT call ghost-web/Perplexity** — `webEvidence` is only used when passed (`score/index.ts:88`) and `run.ts:466` never passes it. Ghost-web belongs to the pasted-URL / url-check ladder only.
- **Registry.** In-memory run registry (`src/server/runs/registry.ts`), a `globalThis` singleton for `next dev` cross-bundle visibility. `RunHandle` = `emit` / `subscribe` / `abort` / `signal`, generic over run kind (`search | tailor`). One active run per `(userId, persona)`. `progress` is **ephemeral, never persisted.**
- **Orphan recovery already exists.** `markStaleRunningOnBoot` (`registry.ts:127`) flips `queued`/`running` rows to `failed` on boot, wired via `src/instrumentation.ts:13`. `failRun` (`run.ts:157-176`) catches unexpected throws, persists `failed`, emits terminal `error` — **but writes only status + error, not accumulated stats**, so a failed run shows `scanned=0`.
- **Hard-cap timer bug.** The worst-case abort timer is set at `run.ts:195` and **cleared right after discovery at `run.ts:262`**, so the long scoring phase is uncovered. `handle.signal` is never threaded into `scoreJob` / the LLM client (which *does* accept a `signal`, `lib/llm/client.ts:30`). A hung scoring phase leaves the run `running` and holds the persona mutex until process restart.
- **Persistence.** `search_runs` (`src/server/persistence/schema.ts:118-128`): `id, user_id, resume_id, personas(jsonb), status(queued|running|completed|failed), stats(jsonb), started_at, finished_at, error`. The DB `stats` jsonb **already holds the rich shape** (`scanned, matched, scored, worth, ghosts, perSource, unscored, capStopped`). `job_scores` is `UNIQUE(jobId, resumeId, policyVersion)` — a policy-keyed verdict **cache that outlives runs**; skipped jobs never get a row.
- **Wire type is narrow.** The Zod `SearchRun` (`src/types/index.ts:164-179`) exposes only `stats: {scanned, worth, ghosts}`; `assemble-run.ts:24` narrows accordingly. `SseEvent` is a hardcoded Zod union (`types/index.ts:284`); the client has a hardcoded `eventNames` array (`features/search/client.ts:36`).
- **Multitenancy.** Every data table carries `user_id`; repos filter by it; shipped behind a scoping-audit gate.
- **Feed run→job coupling is temporal only.** `resolveIsNewCutoff` (`src/server/search/jobsFeed.ts:25-32`) uses the previous completed run's `finishedAt` as an `isNew` cutoff — never a run-id join. No hidden run→job linkage exists elsewhere.
- **Nav.** Sidebar `AppSidebar.tsx` groups nav; **Pipeline** = Matches (`/feed`), Applied (`/tracker`), Interviews (disabled). 14 design-system primitives in `src/caliber-ui/components`; motion primitives `caliber-pulse` / `caliber-spin` and `StageGlyph` / `CheckRunRow` already exist (built for parallel-scoring).
- **Second live surface exists.** `useScanRun` + `ScanProgress` render a live overlay on `/feed`; the resume page auto-fires **both** personas concurrently (`resume/page.tsx:30`) via `scanHandoff`.

---

## 3. Locked decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Job pooling: keep per-user isolation** (status quo). Two similar résumés → one shared `jobs` row (dedup by `userId+dedupeKey`) + a separate `job_scores` row per résumé. | The dominant cost — the match-score LLM call — is a function of *(JD, résumé)* and can never be shared. See §8. |
| D2 | **IA: one Scans hub.** New Pipeline nav item → `/scans` (list + launcher + live). `/scans/:id` = live concurrency-lanes while running, phased-report replay after. | One home for everything scan; matches "a tab where all the scans happened". |
| D3 | **Live view = concurrency lanes** (sources strip → scoring lanes with per-job sub-phase → counts). No per-lane expandable log in v1. | Clearest "current life status"; verbose without a firehose. |
| D4 | **History replay = phased sections** (Discover → sortable Score list → Legitimacy aggregate). | Report-style; best for "which jobs were worth it". |
| D5 | **Persistence = incremental jsonb snapshot on `search_runs`** (a `results` array + duration/cost fields in `stats`). No join table. Write each row as its job settles. | Point-in-time replay; survives `next dev` restarts and failed/partial runs; inherits `search_runs` user scoping. |
| D6 | **Include M0 engine work:** convert scoring to a rolling `pLimit(3)` pool, fix the hard-cap timer to cover scoring, thread the abort signal. | Lanes are only honest with a rolling pool; the timer bug would otherwise show a hung scan's timer ticking forever. |
| D7 | **Retire the Feed `ScanProgress` overlay** (and `scanHandoff`); Feed "Scan now" → start run → navigate to `/scans/:id`; dual-persona auto-start → `/scans` list. | Avoid two divergent live surfaces. |
| D8 | **Sequence as three milestones: M0 engine → M1 history → M2 live.** History-first — M1 needs no SSE work and delivers the retention value alone. | Each milestone is independently shippable; M2 lanes are only honest after M0. |

---

## 4. Architecture

### 4.1 Data model

Additions to `search_runs` (one migration):

- **`results` jsonb NOT NULL DEFAULT `'[]'`** — array of `ScanResult`, appended incrementally as each candidate settles:

  ```
  ScanResult = {
    jobId:          string
    title:          string           // snapshot at scoring time
    company:        string
    source:         string           // source name/id
    outcome:        'scored' | 'unscored' | 'error' | 'skipped'
    verdict?:       'Apply' | 'Consider' | 'Research first' | 'Skip'
    legitimacyTier?: Legitimacy['tier']
    fit?:           number           // 0–5
    scoredMs?:      number           // client-independent wall time for this job
    reason?:        'dailyCap'       // only when outcome='skipped'
    error?:         string           // only when outcome='error'
  }
  ```

  - `results` covers the **≤30 top candidates only**. Outcomes: `scored` (normal), `unscored` (null/empty JD → `EmptyJobDescriptionError`), `error` (a per-job scoring throw — today lost to `console.error` at `run.ts:485`), `skipped` with `reason:'dailyCap'` for candidates left unscored when the cap halts scoring.
  - **Pre-filter cuts** (relocation / tz-band drops at `run.ts:415-419`, and the discover→top-30 slice) are **not** result rows; they stay as aggregate counts in `stats` (`matched`, `unscored`). This keeps `results` bounded at ≤30.

- **Extend the `stats` shape** (DB jsonb already rich; extend the internal `SearchRunStats` type and writers) with: `discoverMs`, `scoreMs`, `costUsd` (accumulated from each `scoreJob`'s cost), `policyVersion`.

**No `timeline` column, no join table.** Two real stages (discover, score) → two duration fields. `startedAt`/`finishedAt` already exist. The join table is rejected: a faithful replay is point-in-time, so joining to live `jobs`/`job_scores` (which mutate/overwrite) would need denormalized columns anyway — a wide table with no query pattern to justify it. `jobId` stays inside each `ScanResult` as a mechanical promote-later escape hatch.

### 4.2 Milestone M0 — scoring engine (pure backend)

1. **Rolling pool.** Replace the batched-3 loop in `scoreTopCandidates` (`run.ts:451-501`) with a rolling `pLimit(3)` pool. Each task: check daily cap *before starting* (over cap → record `skipped:dailyCap`, don't spend); score; emit `job`. Overshoot shrinks from a full batch to in-flight tasks. ~15–20% wall-clock win by killing the convoy effect.
2. **Timer scope + signal.** Keep the worst-case abort timer active across scoring (stop clearing it at `run.ts:262`); thread `handle.signal` into `scoreJob` → the LLM client `signal` so a wedged run actually aborts and releases the persona mutex.
3. **`failRun` persists accumulated stats** (not just status+error), so failed runs report real counts.
4. **Test revert.** The pinned cap test (`run.test.ts:525`) moves back to the older **per-job** cap-check semantics documented at `run.test.ts:534`.

M0 ships with no UI change; the existing coarse progress bar keeps working.

### 4.3 Milestone M1 — history (persistence + Scans tab, no SSE)

- **Migration.** Add `results` jsonb NOT NULL DEFAULT `'[]'` to `search_runs`; extend the internal `SearchRunStats` shape (`discoverMs`, `scoreMs`, `costUsd`, `policyVersion`) and its writers. New table? No — columns only, so `search_runs.user_id` keeps the scoping-audit surface unchanged.
- **Repo.** `searchRuns.appendResult(runId, userId, ScanResult)` → `UPDATE search_runs SET results = results || $1::jsonb WHERE id=$2 AND user_id=$3 AND status='running'` (fenced by status; Postgres row-locking serializes concurrent pool tasks). `searchRuns.listByUser(userId, {limit, cursor})` joining `resumes` for the display name. Stage durations folded into `stats` at stage boundaries.
- **Wire incremental writes** into the M0 pool: each settling task appends its `ScanResult`; discover/score durations recorded at boundaries; `costUsd` accumulated.
- **API.** `GET /api/search` (currently POST-only) → paginated, user-scoped run list (`SearchRunSummary`). `GET /api/search/:id` JSON mode → include `results` + widened `stats`.
- **Contract.** Widen wire `SearchRun.stats` to expose `perSource`, `capStopped`, `unscored`, `discoverMs`, `scoreMs`, `costUsd`, `policyVersion`; add `ScanResult` and `SearchRunSummary` Zod schemas; regenerate `api-contract.md`.
- **UI.** `app/(app)/scans/page.tsx` (list + launcher + pinned live run) and `app/(app)/scans/[id]/page.tsx` (terminal → phased replay). `ScansList`, `ScanReplay` compositions. Add `scans` nav under Pipeline in `AppSidebar` (icon: `activity` or `history`). Feed "Scan now" starts the run and navigates to `/scans/:id`; retire `ScanProgress` + `scanHandoff` (D7); dual-persona auto-start → `/scans`.

  During M1, `/scans/:id` for a *running* run shows the existing coarse progress (reused) until M2 lands.

### 4.4 Milestone M2 — live view (enriched stream + lanes)

- **New SSE events**, both **state-setting / idempotent** (so reconnect needs no replay and duplicate deltas are harmless):
  - `source` `{ sourceId, name, status:'fetching'|'done'|'error', found?, error? }`
  - `jobPhase` `{ jobId, title, company, source, phase:'fetching'|'readingJD'|'scoring'|'rescoring'|'done'|'error', verdict?, legitimacyTier?, fit? }`
    (`phase` maps to real sub-steps: liveness=`fetching`, jdFacts=`readingJD`, matchScore=`scoring`, escalation=`rescoring`; legitimacy-resolve is instant and folds into `done` with the tier. **No `ghostWeb`, no server `lane`.**)
  - Register new names in the `SseEvent` Zod union (`types/index.ts:284`), the registry `RunEvent` type (`registry.ts:15`), and the client `eventNames` array (`client.ts:36`).
- **Reconnect.** A `currentFrame` (source states + active-job phases + counts) is built and owned in `run.ts` — attached to the `RunHandle` as an opaque slot; the registry stays generic and knows nothing about lanes. On subscribe, the route emits an `event:'snapshot'` synchronously (in the existing `start()` block) before live deltas.
- **Client.** A `useScanLive` reducer folds the enriched stream into `{ sources, activeJobs, counts }`; **the client assigns each active `jobId` to a free visual slot** (lanes are pure presentation). Compositions `SourceStrip` + `ScanLanes` reuse `StageGlyph` and the `caliber-pulse`/`caliber-spin` motion primitives. Counts row (`6/30 · 21 queued`).
- **Optional stretch (not core):** a "Cancel scan" button on the live view — real now that the signal is threaded (M0). Note only.

---

## 5. Error handling & edge cases

- **Failed run** → `status='failed'` + `error` + accumulated stats (M0) + whatever `results` were written (M1). List shows `failed` + reason.
- **Cap-hit** → exits via `break`, flows through the normal completion path → `status='completed'` + `stats.capStopped=true`; list badges it `partial`; unscored top-30 candidates recorded as `skipped:dailyCap`.
- **`next dev` restart mid-run** → `markStaleRunningOnBoot` marks it `failed`; incremental `results` (M1) mean the replay still shows what completed before the restart.
- **Reconnect mid-run** → `snapshot`-on-subscribe + idempotent deltas; no event replay.
- **Per-job scoring throw** → `error` result row + `jobPhase{phase:'error'}` (previously vanished into `console.error`).
- **Two similar résumés, overlapping jobs** → two separate runs, each with its own `resume_id` + `results` snapshot; the shared `jobs` row is unaffected (D1).
- **Boundaries fail loud** — validate `SearchRun` / `ScanResult` with `Schema.parse`; no fallback defaults.

---

## 6. Testing strategy

- **M0:** rolling-pool concurrency (≤3 in flight), cap-check-before-start (no spend over cap; `skipped:dailyCap` recorded), timer covers scoring / abort releases mutex, `failRun` persists stats. Revert pinned cap test to per-job semantics.
- **M1:** `appendResult` fenced-write + append semantics; `listByUser` scoping + pagination + résumé-name join; detail JSON includes `results` + widened `stats`; a scan with a mocked LLM asserts `results` persisted incrementally and the replay renders; failed/cap-hit runs carry partial results.
- **M2:** event→frame reducer (idempotent state-setting deltas, client lane assignment); `snapshot`-on-subscribe hydration for a late subscriber; new `SseEvent` variants validate; `ScanProgress` retirement doesn't break Feed/resume flows.

---

## 7. Contract & docs impact

- `src/types/index.ts`: widen `SearchRun.stats`; add `ScanResult`, `SearchRunSummary`; extend `SseEvent` union.
- `src/server/persistence/schema.ts` + a Drizzle migration: `results` jsonb; extended `stats` writers.
- `docs/architecture/api-contract.md`: regenerate from Zod.
- `docs/architecture/component-inventory.md`: add `ScansList`, `ScanReplay`, `SourceStrip`, `ScanLanes`.

---

## 8. Non-goals & thread-3 footnotes (recorded, not built here)

- **Keep per-user isolation (D1).** A global shared job pool is rejected: the match-score cost is inherently per-(user, résumé); `jobs` rows carry user-relative state (eligibility resolved against the user's profile, persona, seen/applied), so "one row + views" is a table-split, not a view.
- **Reversible path if scale demands it:** a global **postings *cache*** keyed by `dedupeKey`, holding only user-independent artifacts (fetched JD text, `jdFacts`, liveness) — additive, reverses nothing, leaks nothing about *who* found a posting. Not now.
- **Follow-up A (tiny, separate ticket):** a cross-user `dedupeKey` **collision counter** to measure when that cache is worth building.
- **Follow-up B (opportunistic):** **C-lite** — reuse Stage-1 `jdFacts` (never the fit score) next time the scoring path is touched. Reusing the fit score is rejected (silent substitution violates fail-loud culture).
- **Deferred:** join table for cross-run job queries (promote from the `jobId`-in-results escape hatch if ever needed); per-lane expandable event logs; a UI cancel button (stretch).

---

## 9. Open questions

None blocking. Icon choice for the Scans nav item (`activity` vs `history`) is cosmetic and decided during M1.
