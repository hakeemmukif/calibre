# Handoff — Parallel Scoring (concurrent background scoring + live UI)

**Status:** Design complete and committed. Implementation NOT started.
**Branch:** `feat/parallel-scoring` (off `main`; spec commit `66dd71b`).
**Authoritative spec:** `docs/superpowers/specs/2026-07-13-parallel-scoring-design.md`
**Memory:** `project-parallel-scoring-spec.md`
**Date:** 2026-07-13

## What this is
Make "scoring fit" concurrent + backgrounded for a single operator. Today a paste is one-at-a-time
and tab-blocking (`useUrlCheck` supersedes prior runs; `void runPipeline` fire-and-forgets in the
request handler). Target: paste many URLs, up to N=3 score at once in the background, surfaced as a
breathing corner tray + a feed status card + a details banner. Per-job latency (~30s) is unchanged —
the win is concurrency + never blocking. LLM layer is deliberately untouched.

## Where we are
**Done:** brainstorm (4 decisions locked via Q&A); codebase mapped, design produced, and
adversarially stressed (all Fable); spec written, self-reviewed, committed.
**Not done:** the implementation plan; any code.

## Do this next (in order)
1. **Clear the blocker below.**
2. Invoke the **writing-plans** skill against the spec → ordered implementation plan.
3. Build. Per project convention, dispatch to **Sonnet** executors, **Fable** reviews. Suggested
   phase order (each independently testable):
   a. schema + drizzle migration + repo (`claimNextQueued`, lease/list methods, fenced writes);
   b. worker singleton + `instrumentation.ts` boot recovery + routes (`202`, `?ids=`, `?active=1`);
   c. `checksStore` (replaces + deletes `useUrlCheck`), port `useUrlCheck.test.ts`;
   d. `CheckDock` + `ScoringStatusCard` + `ReScoringBanner` + `StageGlyph` export + page wiring;
   e. tests green + full `npm run check`.
4. **Verify by driving it** (`/verify` or `/run`), not just tests: paste 3+ URLs, watch them score
   in parallel, navigate away (tray keeps breathing), restart the process mid-run and confirm the
   queued/running work resumes instead of dying.

## Blocker — clear FIRST
`src/features/url-check/useUrlCheck.ts` and `src/server/url-check/run.ts` have **uncommitted
working-tree changes** (prior LinkedIn/gate work). This feature **deletes** `useUrlCheck.ts` and
**edits** `run.ts`, so commit or stash that work before building or it tangles. Also uncommitted and
unrelated: `src/server/score/index.ts`, `src/server/url-check/run.test.ts`,
`src/features/url-check/useUrlCheck.test.ts`.

## Locked decisions — DO NOT relitigate
- **Single-operator NOW**, scale-ready by migration (no `userId` built; column + `WHERE` later).
- **LLM layer UNCHANGED** — no model/provider/prompt/streaming change. Speed from concurrency +
  backgrounding only.
- **Queue = the existing `url_checks` table.** No Redis / pg-boss / new dependency. A boot-started
  `globalThis` worker singleton OWNS execution, replacing the fire-and-forget.
- **Persistent surface = corner tray, bottom-right** (chosen over top strip and bell+panel — only
  option that survives navigation).

## Critic must-fixes — NON-NEGOTIABLE (design is unsound without all five)
1. **Fence all four row-writes** (`updateStage`/`addCost`/`complete`/`fail`) by
   `status='running' AND attempts=$claimed` — not `status` alone. Else a zombie attempt-1 run
   terminal-writes its attempt-2 twin's row.
2. **Cost cap = PAUSE, never fail.** Cap hit → worker stops claiming; queued rows stay queued.
   Never terminal-fail durable queued work.
3. **Rehydrate URL-mode rows** as `raw.text ?? undefined` then `UrlCheckRequest.parse(...)`.
   `raw.text` is `null` for URL mode and `UrlCheckRequest.text` rejects `null` — every URL row
   breaks on day one otherwise.
4. **Serialize the drain loop** (single in-flight flag) so a second `kick()` can't claim into a
   slot the first hasn't filled yet.
5. **Server lease owns liveness** (8 min > any healthy run); client drops its `MAX_RUN_MS` hard
   deadline and trusts DB truth (keeps `MAX_POLL_FAILURES=8` for network resilience only).

## Deliberately CUT (do not re-add for MVP)
Boot-requeue accelerator; partial-unique dedupe index + attach-on-conflict; admission-time cost-cap
`429`; the 60s server-side "recently finished" window; the in-process `Promise.race` watchdog. See
spec §7.

## Key anchors (verified)
- `src/server/url-check/run.ts` — `:289` `startUrlCheck` admission; `:342` `raw:{text: req.text ?? null}`;
  `:353` `void runPipeline(...)` (replace with worker kick; export `runPipeline`).
- `src/instrumentation.ts` — `register()` calls `urlChecksRepo.markAllUnfinishedAsFailed()`
  (replace with `requeueOrphanedRunning`, then start the worker).
- `src/server/persistence/repos/urlChecks.ts:19–57` — the four unfenced write methods.
- `src/server/persistence/schema.ts:212` — `url_checks` table (add `attempts`, `lease_expires_at`,
  partial index).
- `src/types/index.ts:291` — `UrlCheckRequest.text` = `z.string().min(1).optional()` (rejects null).
- `src/server/search/run.ts` — `SCORE_BATCH_SIZE=3` (concurrency precedent) + `CALIBER_DAILY_LLM_USD`
  cap idiom to reuse.
- `src/caliber-ui/compositions/Feed/ScanProgress.tsx` — `StageGlyph` to export; stage-row template.
- `src/app/AppShell.tsx` — mount `CheckDock` here (persists across routes).

## Scope
WILL: spec §7. WILL NOT / deferred: spec §8 (evaluate-endpoint re-plumb; `AbortSignal` cancellation;
honest cost-cap TZ fix + `url_checks` cost inclusion; SSE transport; unify scanned path onto the
queue). Full file-change inventory: spec §10.
