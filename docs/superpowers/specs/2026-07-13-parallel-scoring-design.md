# Parallel Scoring — concurrent background scoring + live UI

**Date:** 2026-07-13
**Status:** design approved, pending implementation plan
**Supersedes/extends:** `2026-07-12-pasted-job-ingestion-design.md` (§10/§11 url-check pipeline)

## 1. Goal

Turn "scoring fit" from a **one-at-a-time, tab-blocking** action into **concurrent background
scoring** for a single operator, surfaced as a persistent breathing UI. Same scoring quality,
higher throughput, never blocks the user.

The operator can paste many URLs; up to **N run at once** in the background; each individual
run stays ~30s (acceptable — a real scrape + LLM call). The win is **concurrency +
backgrounding**, not per-job latency.

## 2. Locked decisions (do not relitigate)

- **Scope: single-operator NOW, scale-ready by migration.** There is no `userId` column anywhere
  (`profile` is a singleton `id="default"`). We do **not** build tenancy/auth now, but every
  primitive is chosen so adding `user_id` later is a column + `WHERE` clause, not a rewrite.
- **LLM layer unchanged.** No change to model (`openai/gpt-oss-120b`), provider routing, prompt,
  or streaming. Each `scoreMatch` call stays ~20–36s. All speed comes from running many jobs at
  once and never blocking the UI.
- **Persistent surface = corner tray (bottom-right).** Chosen over a top-of-dashboard strip and a
  bell+panel because it is the only option that keeps signalling background work **after the user
  navigates away** from the feed.
- **No new infra.** No Redis, no pg-boss, no queue library. The queue is the existing
  `url_checks` table + Postgres `FOR UPDATE SKIP LOCKED`. `p-limit` (already a dependency) is the
  per-process throttle.

## 3. Current state (verified)

- **Runtime:** long-lived Node (`next start`). No serverless/edge config. DB is a module-singleton
  `postgres.js` client (default pool ~10, `src/server/persistence/db.ts`).
- **One scoring = the url-check pipeline.** Dominant cost is a single `match-score` call
  (`gpt-oss-120b`, non-streaming). `ghost-web` (`perplexity/sonar`, ~3s) already runs concurrently,
  hidden under `scoreMatch`. Everything else is serial and cheap.
- **Execution is owned by the request handler.** `startUrlCheck` (`src/server/url-check/run.ts:289`)
  inserts a `url_checks` row (`status:"queued"`, `raw:{text: req.text ?? null}` at `:342`) then
  **fire-and-forgets** `void runPipeline(...)` at `:353`. Works only because the process is
  long-lived. No concurrency gate, no queue, no cost gate on this path.
- **Client is single-run.** `useUrlCheck.ts` fires `POST /api/jobs/check`, then polls
  `GET /api/jobs/check/:id` every 1500ms. A monotonic `generationRef` makes each new submit
  **supersede** the previous run — the opposite of concurrent scoring.
- **`url_checks` is already a durable job record:** `id, url, dedupeKey (best-effort, NOT unique),
  status(queued|running|completed|failed), stage, jobId (set null on delete), alreadyKnown,
  needsText, error(jsonb {code,message}), costUsd, raw(jsonb), createdAt, finishedAt`
  (`src/server/persistence/schema.ts:212`).
- **Boot code destroys queued work:** `src/instrumentation.ts` `register()` calls
  `urlChecksRepo.markAllUnfinishedAsFailed()`, which fails every `queued`/`running` row on restart.
- **Repo write methods are unfenced:** `updateStage/complete/fail/addCost`
  (`src/server/persistence/repos/urlChecks.ts:19–57`) match on `id` only.
- **Precedents to reuse:** `SCORE_BATCH_SIZE=3` concurrent `gpt-oss-120b` (proven in
  `src/server/search/run.ts`); `globalThis`-guarded singleton (`src/server/runs/registry.ts`);
  `caliber-pulse`/`caliber-spin` keyframes (`src/caliber-ui/styles/tokens.css:126–127`);
  `ScanProgress` stage-glyph rows; `AppShell.tsx` wraps every route.

## 4. Backend — `url_checks` as the queue

### 4.1 Shape

`url_checks` becomes a durable work queue. The only missing primitive is an **atomic claim**.
Execution moves from the request handler into a **boot-started worker singleton** that owns the
lifecycle. Every UI surface reads DB truth, which is what makes backgrounding, restart-survival,
and multi-tab free.

### 4.2 Schema changes (one table, one migration)

Add to `url_checks`:
- `attempts` — `integer NOT NULL DEFAULT 0`. Incremented at claim. Governs **orphan recovery
  only** (max 2 attempts), never in-run retries.
- `lease_expires_at` — `timestamp` nullable. Set at claim to `now() + 8 min` (see §4.7 timer
  ordering).
- Partial index for the claim scan: `(status, created_at) WHERE status = 'queued'`.

`UrlCheck` wire shape is **unchanged** — `attempts`/`lease_expires_at` are DB-internal.

### 4.3 Worker (`src/server/url-check/worker.ts`, new, ~100 lines)

- `globalThis`-guarded singleton (mirrors `runs/registry.ts`) so Next dev bundle duplication and
  HMR don't spawn two workers/intervals. Started **only** from `instrumentation.ts` — never as a
  module side-effect (route-bundle imports must not start it in tests).
- `pLimit(SCORE_CONCURRENCY)` where `SCORE_CONCURRENCY = 3` (a `const` next to `SCORE_BATCH_SIZE`,
  same evidence; not an env var — YAGNI until multi-process).
- **`kick()` — serialized drain loop.** A single in-flight `draining` flag guards the loop so two
  kicks can't both claim into the same free slot. While a `p-limit` slot is free **and** the daily
  cost cap is not hit: `claim → submit to p-limit → re-check`. Claim returns nothing → stop until
  the next kick/interval.
- **15s `setInterval`** (the permanent, multi-process-safe recovery mechanism): (a) `kick()`, and
  (b) requeue expired leases — `status='running' AND lease_expires_at < now()`: `attempts < 2` →
  back to `queued`; `attempts >= 2` → `failed` with a specific stale error. Must be `unref()`'d so
  tests/scripts can exit.
- **Per claimed row:** rehydrate the request (see §4.6 — the day-one bug), re-run the
  `hasAnyScore` short-circuit (a duplicate that got scored while this row waited finishes as
  `alreadyKnown`, zero LLM spend), fetch the active resume + profile (missing → fail the row
  loudly), then call the **existing `runPipeline` unchanged**.

### 4.4 Repo changes (`repos/urlChecks.ts`)

Add:
- `claimNextQueued()` — one autocommit statement, **no surrounding transaction**:
  ```sql
  UPDATE url_checks
     SET status = 'running', attempts = attempts + 1,
         lease_expires_at = now() + interval '8 minutes'
   WHERE id = (SELECT id FROM url_checks
                WHERE status = 'queued'
                ORDER BY created_at
                FOR UPDATE SKIP LOCKED
                LIMIT 1)
  RETURNING *;
  ```
- `requeueExpiredLeases(maxAttempts)` / `failExpiredLeases(maxAttempts)` — the sweeper.
- `requeueOrphanedRunning()` — boot recovery (replaces `markAllUnfinishedAsFailed`): requeue
  orphaned `running` rows within the attempt budget, terminal-fail `attempts >= 2`, leave `queued`
  rows queued.
- `listActive(): UrlCheckRow[]` — all `queued`/`running` rows (for `?active=1` reload hydration).
- `listByIds(ids): UrlCheckRow[]` — exact rows regardless of status (for `?ids=` tracked polling).

Change:
- **Fence all four in-run writes** (`updateStage`, `addCost`, `complete`, `fail`) with
  `WHERE id = $1 AND status = 'running' AND attempts = $claimedAttempt`. Without this, a zombie
  attempt-1 run can terminal-write the row its attempt-2 twin is executing (see §4.7). This is the
  single most important correctness fix.

### 4.5 Routes

- `POST /api/jobs/check` — admission (`startUrlCheck`) is **unchanged** except: replace `void
  runPipeline(...)` (`run.ts:353`) with `urlCheckWorker.kick()`; return `202`. The scored-dedupe
  short-circuit still returns `{started:false}` immediately with zero LLM spend.
- `GET /api/jobs/check?ids=<csv>` — batched poll: `listByIds`. **One request per 1.5s regardless of
  how many runs are active** (fixes the k-requests-per-tick multiplexing problem the moment
  concurrency exists).
- `GET /api/jobs/check?active=1` — reload hydration: `listActive`. Lets the dock repopulate after a
  hard refresh, since in-memory client ids are gone. **No server-side "recently finished" window**
  (that window was cut — it created a stuck-card bug).
- `GET /api/jobs/check/:id` — kept for deep links.

### 4.6 Rehydration (day-one correctness)

A URL-mode row has `raw.text === null`. `UrlCheckRequest.text` is `z.string().min(1).optional()`
(`src/types/index.ts:291`) which **rejects `null`**. The worker MUST rebuild as
`(row.raw as {text: string|null}).text ?? undefined` and then `UrlCheckRequest.parse(...)` so a
malformed payload fails that row loudly instead of crashing the loop or silently entering
paste-mode. Covered by a worker test that claims one URL-mode and one paste-mode row.

### 4.7 Recovery & correctness invariants (all MUST)

- **Attempt fencing** on every row-write (§4.4) — first-writer-wins by `status` is not enough; a
  twin must be excluded by `attempts`.
- **Timer ordering:** `lease (8 min) > client MAX_RUN_MS (5 min)`. The row's liveness is now owned
  by the server lease, not the client. No separate in-process watchdog — lease + fencing is the
  single recovery story (a redundant `Promise.race` watchdog that cancels nothing was cut).
- **Autocommit claim:** never wrap claim+pipeline in `db.transaction()` (would hold a connection
  across the whole ~30s run and defeat `SKIP LOCKED`).
- **Idempotent re-run:** safe by construction — `jobsRepo.upsertByDedupeKey` is idempotent,
  `job_scores` has the `(jobId,resumeId,policyVersion)` unique upsert, and paste text persists in
  `raw.text`. `url_checks.costUsd` accumulating across attempts is acceptable (audit figure,
  bounded by the attempt cap).
- **Terminal failure semantics unchanged:** `mapFailure`'s user-actionable codes
  (`FETCH_BLOCKED`/`NOT_A_JOB_POSTING`/`EXTRACTION_FAILED`) stay terminal — `attempts` never
  retries them.
- **Deleted job row:** `complete()` needs a `jobId`; handle the job having been deleted between
  admission and claim (jobId fk is set-null) — fall through to a normal run, don't throw.

### 4.8 Concurrency & cost cap

- **N = 3 concurrent** url-checks per process (`p-limit`), matching the proven `SCORE_BATCH_SIZE`.
  Worst-case LLM fan-out with a live scan is 3 + 3 = 6 concurrent `match-score` calls — OpenRouter
  tolerates this; spend stays bounded by the cap. Stated in the plan so it's a conscious number.
- **Cost cap = PAUSE, never fail.** The worker stops claiming when
  `sumCostUsdSince(startOfToday())` ≥ `CALIBER_DAILY_LLM_USD` (the existing scan-path idiom). Queued
  rows **stay queued** and resume when the window resets. The batched endpoint surfaces a
  `paused: daily cap` signal. Terminal-failing durable queued work on a cap hit is explicitly
  forbidden — it destroys exactly what the queue exists to preserve, and the cap window resets at
  midnight anyway.
- **Pool math:** `postgres.js max=10` is ample — pipeline DB writes are ms-bursts between multi-second
  LLM waits; 3 workers + handlers + a scan never approach 10 simultaneous queries. No change now.

## 5. Frontend — one store, three surfaces

### 5.1 `checksStore` (`src/features/url-check/checksStore.ts`, new, ~130 lines)

A **module-singleton** store (not React Context — `AppShell` persists across App Router
navigations, so a singleton lets feed, details, and dock all subscribe with zero provider
plumbing) exposed via `useSyncExternalStore` as `useUrlChecks()`. **Replaces and deletes**
`useUrlCheck.ts`.

Semantics change from *supersede* to *collect*: a new `submit()` **adds** a run; staleness is
per-run identity (a poll applies only if its key is still present and non-terminal; `dismiss(key)`
deletes it so late responses no-op naturally — no `generationRef`). One shared 1.5s interval sweeps
all active runs, started when the first goes active, stopped when none remain. Per-run resilience
keeps `useUrlCheck`'s `MAX_POLL_FAILURES = 8` (consecutive poll failures fail **that run only** —
network resilience), but **drops the client `MAX_RUN_MS` hard deadline**: now that the server lease
owns liveness (§4.7), a run is terminal only when its `url_checks` row is terminal, so a
slow-but-healthy run is never falsely failed by the client. On completion the store does the existing
`getJob(check.jobId)` step and stores the `Job`. Terminal runs persist in the collection until
dismissed — that persistence is what lets the dock show completions after navigation.

```ts
export type CheckRunPhase = 'starting' | 'queued' | 'fetching' | 'scoring' | 'done' | 'needsText' | 'failed';

export interface CheckRun {
  key: string;              // crypto.randomUUID() at submit — stable React key before the server id exists
  checkId: string | null;   // set when startCheck resolves
  url: string;
  origin: 'paste' | 'reevaluate';
  jobId: string | null;     // known upfront for reevaluate; set on completion for paste
  job: Job | null;          // fetched on completion
  phase: CheckRunPhase;     // derived; 'running' splits on server check.stage
  stage: string | null;     // raw server check.stage — never invented
  alreadyKnown: boolean;
  error: { code: string; message: string } | null;
  startedAt: number;
  finishedAt: number | null;
}

export function useUrlChecks(): {
  runs: CheckRun[];          // ordered newest-first
  active: CheckRun[];        // phase in starting|queued|fetching|scoring
  doneCount: number;         // monotonic — the feed reload effect keys on it
  submit(url: string, text?: string): string;   // returns key; returns existing key if url already active
  submitEvaluate(jobId: string): string;         // wraps POST /api/jobs/:id/evaluate as a run
  retryWithText(key: string, text: string): void;
  dismiss(key: string): void;
  clearFinished(): void;
};
```

Reload hydration: on mount the store may call `GET /api/jobs/check?active=1` to repopulate
in-flight runs. Tenancy-later: this is per-session client state over user-scoped API calls — auth
scopes the fetches, the store shape is untouched.

### 5.2 `CheckDock` — corner tray (`src/caliber-ui/compositions/Shell/CheckDock.tsx`, new, ~80 lines)

Fixed bottom-right (24px inset), mounted once in `AppShell`, z-index **below** the `ScanProgress`
scrim. **Hidden on `/feed`** (the inline card is the surface there) and **hidden under the scan
scrim** during a market scan — so no surface ever double-reports.

- **Collapsed (default while runs active):** a pill `Card` (`radius="xl"`, `elevation="lg"`) with an
  8px accent dot breathing via `caliber-pulse 1.6s ease-in-out infinite alternate` (**this is the
  "breathing modal"**) + `Scoring 3 roles` (live `tabular-nums` count) + a chevron `IconButton`. An
  unseen-completion count badge (NotificationBell badge styling) appears when runs finish
  un-viewed.
- **Expanded:** ~320px vertical stack of up to 5 `CheckRunRow`s, newest first, `+N more` overflow,
  `Clear finished` ghost footer button. **Multiple rows spinning simultaneously is the
  parallelism display** — no fabricated progress bars.
- **Completion:** row glyph → green check, breathing stops, row becomes a link to `/jobs/:jobId`;
  `alreadyKnown` captions "Already in your feed". **Failed:** `error.message` + Retry. **needsText:**
  a "Paste the posting text" action routing to `/feed` bound to the run key.
- Per-row dismiss removes it from the store (the **server run continues** — `url_checks` is
  durable); the dock unmounts when the collection empties.

### 5.3 `ScoringStatusCard` — feed (`src/caliber-ui/compositions/Feed/ScoringStatusCard.tsx`, new, ~50 lines)

Slotted **exactly where `EvalResultCard` renders today** (`feed/page.tsx:178–191`) so pending work
occupies the same spot its result will land. One `Card` (`maxWidth 480`, `padding="md"`). Header:
breathing accent dot + `Scoring {N} roles in parallel` + caption `each takes about 30 seconds —
keep browsing, results drop into your feed`. Body: one `CheckRunRow` per run, states mapping 1:1 to
server truth (`queued`→"waiting for a slot", `fetching`→"reading the posting", `scoring`→"scoring
fit · ghost check running alongside", `done`/`failed`/`needsText`). **Breathing is confined to the
header dot and spinning glyphs — never opacity-pulse text-bearing copy.** On completion the store
fetches the `Job` and the existing feed-reload effect (`page.tsx:99–101`, generalized from
`persona==='pasted'` to "any run completed") makes the real `JobRow` (with `NewBadge`) appear at the
top — spatial continuity. The most-recent un-dismissed completion also renders a full
`EvalResultCard` beneath the status card (preserving today's single-result behaviour); earlier ones
stay compact "View" rows.

### 5.4 `ReScoringBanner` — details (`src/caliber-ui/compositions/Detail/ReScoringBanner.tsx`, new, ~25 lines)

On `/jobs/:id`, re-evaluate becomes a run in the same store. A slim banner `Card` renders as a
**sibling above `JobDetail`** in `jobs/[id]/page.tsx` — **not** a new prop on the frozen `JobDetail`
composition. The page derives `evaluateStatus='evaluating'` from "store has an active run with
`jobId === id`" (existing `JobDetail.tsx:158–174` unchanged). Banner: breathing dot + spinning glyph
+ `Re-scoring this role — {reading the posting | scoring fit}` + caption `runs in the background —
you can leave this page` + a parallel-context suffix when others are active: `· 3 other checks
running` (**this is "scoring fit running in parallel"** — the page names its own run and acknowledges
the concurrent set; the dock, visible here, breathes the rest). `submitEvaluate(jobId)` wraps the
current synchronous `POST /api/jobs/:id/evaluate` as a run (synthetic `scoring` stage); on success
the page swaps `setJob(freshJob)` and the banner flips to a brief "Updated just now" state.

### 5.5 Motion & net-new components

Everything composes from existing primitives — **no new keyframes, no new tokens, no new
dependency, no portals, no toast/popover machinery**:
- **Breathing:** `caliber-pulse` on non-text dots only (1.6s for calm ambient breath).
- **Working:** `caliber-spin` on `Icon "refresh-cw"` in an `--accent-soft` circle — `ScanProgress`'s
  `StageGlyph` active state verbatim.
- **Done/Failed:** `Icon "check"` in `--fit-strong-soft` / `Icon "triangle-alert"` in `--danger-ink`.
- Net-new: **export `StageGlyph`** from `ScanProgress` (add `export` + a `size` prop); shared
  **`CheckRunRow`** (~40 lines); `CheckDock`, `ScoringStatusCard`, `ReScoringBanner`; `checksStore`.

## 6. Scale-ready path (built-in, not built-now)

- **More throughput (multi-process):** run the identical worker in more processes (extra `next
  start`, or a thin `worker.ts` entrypoint importing the same module). `FOR UPDATE SKIP LOCKED`
  already arbitrates claims; the lease sweeper already reaps a dead peer's rows. The **only** change
  is dropping any single-owner boot assumption — so we keep boot recovery minimal and clearly named.
- **More users (multi-tenant):** pure migration — `ADD COLUMN user_id` (backfill `'default'`, then
  `NOT NULL`) to `url_checks`/`jobs`/`resumes`/`profile`; admission fetches the caller's
  resume/profile instead of the singletons (the worker already re-fetches per claimed row); the
  cost-cap query and `?active=1` gain `WHERE user_id=$1`; the claim optionally gains an
  `ORDER BY`/priority tweak for fairness. The claim SQL, status machine, `runPipeline`, client
  store, and poll all stay identical.
- **Transport at scale:** the client store consumes "a stream of `UrlCheck` snapshots", so swapping
  1.5s polling for a batched endpoint or SSE later touches only the client fetch layer + one route.

## 7. Scope boundary

**WILL:** queue + worker over `url_checks` (schema, claim, fencing, lease/attempts recovery,
serialized drain, pause-on-cap); `checksStore` replacing/deleting `useUrlCheck`; `CheckDock` (corner
tray) + `ScoringStatusCard` (feed) + `ReScoringBanner` (details); batched `?ids=` + `?active=1`
endpoints; boot recovery replacing `markAllUnfinishedAsFailed`; tests (worker claim/lease/fencing;
store tests porting `useUrlCheck.test.ts`).

**WILL NOT (deferred — see §8):** multi-tenancy / `userId` / auth; any LLM model/provider/prompt
change; re-plumbing `POST /jobs/:id/evaluate` through `url_checks`; `AbortSignal` cancellation of
orphaned LLM calls; fixing the pre-existing cost-cap TZ bug / sonar cost undercount; pg-boss /
Redis / any new infra.

**Deliberately CUT from the first design draft** (over-engineered for single-op MVP, per adversarial
review): the boot-requeue "accelerator" (redundant with the lease sweeper, and the one thing that
must be deleted for multi-process); the partial-unique dedupe index + attach-on-conflict flow (the
claim-time `hasAnyScore` re-check already zeroes duplicate spend); the admission-time cost-cap `429`
(the worker pre-claim pause + a `paused` status gives the same feedback with one fewer error path);
the 60s server-side "recently finished" window (it created a stuck-card bug); the in-process
`Promise.race` watchdog (lease + fencing already covers it).

## 8. Deferred follow-ups (explicitly out of scope, tracked here)

1. Re-plumb `POST /jobs/:id/evaluate` through `url_checks` so re-evaluate gets real stages and
   survives navigation server-side (the banner ships over the sync endpoint either way).
2. Thread an `AbortSignal` through `runPipeline`/`getLlm`/`scoreJob` so a timed-out LLM HTTP call is
   actually cancelled (today it leaks until the provider returns).
3. Make the daily cost cap honest: fix the local-midnight-vs-`timestamp` TZ bug (project memory),
   add `url_checks.costUsd` (gate/search/ghost spend) to the sum, and refresh `createdAt` on
   `job_scores` re-scores. Pause-on-cap makes a slightly-wrong cap harmless, hence deferral.
4. Batched-endpoint or SSE transport when per-tick poll load matters (post multi-tenant scale).
5. Unify the scanned path's `scoreTopCandidates` onto the same claim-based engine (one total-LLM
   concurrency number) — would add a `job_kind` column to the queue.

## 9. Testing

- **Worker:** claim one URL-mode + one paste-mode row (rehydration §4.6); `SKIP LOCKED` picks a
  distinct row under concurrency; expired lease requeues once then fails at `attempts=2`; fenced
  writes — a stale-attempt `complete()`/`fail()` no-ops against a row held by a newer attempt;
  serialized drain never claims more rows than free slots; pause-on-cap leaves rows `queued`.
- **Store:** port `useUrlCheck.test.ts` scenarios with fake timers — supersede-on-submit becomes
  add-run (both survive); `dismiss`-then-late-poll no-ops; `MAX_POLL_FAILURES`/`MAX_RUN_MS` fail one
  run only; `submit` dedupes an already-active URL.
- **Route:** `POST` returns `202` and kicks; `?ids=` returns exact rows; `?active=1` returns
  in-flight only; scored-dedupe short-circuit still returns `{started:false}` with zero LLM calls.
- Full `npm run check` (typecheck + vitest + contract + build) green.

## 10. File-change inventory

| Change | File |
| --- | --- |
| NEW worker singleton | `src/server/url-check/worker.ts` |
| EDIT claim/lease/list + fence writes; replace `markAllUnfinishedAsFailed` | `src/server/persistence/repos/urlChecks.ts` |
| EDIT `attempts` + `lease_expires_at` + partial index (+ drizzle migration) | `src/server/persistence/schema.ts` |
| EDIT replace `void runPipeline` with worker kick; export `runPipeline` | `src/server/url-check/run.ts` |
| EDIT replace boot-fail with `requeueOrphanedRunning` + start worker | `src/instrumentation.ts` |
| NEW batched `?ids=` / `?active=1` list handler | `src/app/api/jobs/check/route.ts` (+ existing `[id]` unchanged) |
| EDIT/DELETE store replaces & deletes the hook | `src/features/url-check/checksStore.ts` (new), `useUrlCheck.ts` (del) |
| NEW corner tray | `src/caliber-ui/compositions/Shell/CheckDock.tsx` + mount in `src/app/AppShell.tsx` |
| NEW feed status card | `src/caliber-ui/compositions/Feed/ScoringStatusCard.tsx` |
| NEW details banner | `src/caliber-ui/compositions/Detail/ReScoringBanner.tsx` |
| EDIT export `StageGlyph` + `size` prop; NEW shared `CheckRunRow` | `src/caliber-ui/compositions/Feed/ScanProgress.tsx`, `.../CheckRunRow.tsx` |
| EDIT wire pages to the store | `src/app/feed/page.tsx`, `src/app/jobs/[id]/page.tsx` |
| EDIT document endpoints (`UrlCheck` shape unchanged) | `docs/architecture/api-contract.md` |
