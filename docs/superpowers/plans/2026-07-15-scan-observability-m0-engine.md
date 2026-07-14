# Scan Observability — M0 (Scoring Engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the scan's scoring phase from a batched-3 `Promise.all` loop into a rolling `pLimit(3)` pool with a per-job daily-cap gate, extend the hard-cap timer to cover scoring, and thread the run's abort signal into the scoring LLM calls so a wedged scan can't hang forever.

**Architecture:** All changes are inside the existing inline-async run engine (`src/server/search/run.ts` + `src/server/score/*`). No schema, no API, no UI. The existing coarse SSE progress bar keeps working unchanged; M0 is a pure backend prerequisite so that the M2 live "lanes" are honest (lanes only flow with a rolling pool) and don't render a hung run's timer ticking forever.

**Tech Stack:** TypeScript, Next.js 15 (Node runtime), `p-limit`, Drizzle + PGlite (in-process test DB), Vitest, OpenRouter (OpenAI-compatible) LLM client.

## Global Constraints

- **Layering:** UI → `features/*` → `server/*`; only `server/*` touches the DB or the LLM. (M0 touches only `server/*`.)
- **Fail loud:** validate at boundaries (`Schema.parse`); no fallback defaults, no silent `0`/`""`/`unknown`.
- **LLM:** OpenRouter only, via the existing `LlmClient`; cheapest viable model per task (`config/models.yml`). Never add `claude -p` subprocesses.
- **Surgical diffs:** match existing style; every changed line traces to this plan; no speculative abstractions.
- **Contract:** Zod schemas in `src/types` are the source of truth. (M0 changes no wire types.)
- **Green gate:** `npm run check` (typecheck + vitest + contract + build) must pass before M0 is done.
- **Concurrency width:** the rolling scoring pool defaults to **3** simultaneous jobs (unchanged from the batch size), overridable per-run via a new `scoreConcurrency` dep used only by tests.

---

### Task 1: Rolling scoring pool with per-job daily-cap gate

Replace the batched `Promise.all`-per-3 loop in `scoreTopCandidates` with a rolling `pLimit` pool. The daily-cost cap is now checked **as each slot opens** (per job) rather than between batches: once running spend crosses the cap, every not-yet-started job bails without spending, while the ≤2 in-flight jobs finish (overshoot bounded by pool width, not a full batch). A new `scoreConcurrency` dep makes the pool width injectable so the cap test is deterministic.

**Files:**
- Modify: `src/server/search/run.ts` (constant `SCORE_BATCH_SIZE` → `SCORE_CONCURRENCY`; `StartSearchDeps` gains `scoreConcurrency?`; rewrite `scoreTopCandidates` body ~`run.ts:440-501`)
- Test: `src/server/search/run.test.ts` (rewrite the daily-cap test ~`:525-561`; refresh the stale "batched scoring" test name/comment ~`:563-593`)

**Interfaces:**
- Consumes: `pLimit` (already imported `run.ts:8`), `scoreJob` (`@/server/score`, unchanged signature this task), `assembleJob`, `jobScoresRepo.sumCostUsdSince`, `ensureDescription`, `resolveIsNewCutoff`, `EmptyJobDescriptionError`.
- Produces: `StartSearchDeps.scoreConcurrency?: number` (default `SCORE_CONCURRENCY = 3`); `scoreTopCandidates` returns the same `{ scored, worth, ghosts, unscored, capStopped }` shape as before.

- [ ] **Step 1: Add the `scoreConcurrency` dep to the type so the new test compiles**

In `src/server/search/run.ts`, add one field to `StartSearchDeps`:

```ts
export interface StartSearchDeps {
  concurrency?: number;
  connectorTimeoutMs?: number;
  hardRunTimeoutMs?: number;
  connectorForSource?: (source: SourceRow) => SourceConnector;
  llm?: LlmClient;
  dailyCapUsd?: number;
  // Rolling scoring-pool width. Default SCORE_CONCURRENCY (3). Injected by
  // tests to force strictly-sequential scoring (scoreConcurrency: 1) so the
  // per-job cap gate is deterministic.
  scoreConcurrency?: number;
}
```

- [ ] **Step 2: Rewrite the daily-cap test to assert per-job gate semantics (the failing test)**

In `src/server/search/run.test.ts`, replace the entire `it("daily cost cap: ...")` test (~`:525-561`) with:

```ts
  it("daily cost cap: per-job gate stops scoring once dailyCapUsd is crossed (rolling pool, single slot), still completes", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });

    // Four matching candidates (distinct companies → 4 separate jobs).
    // costingLlm charges 0.02/job (0.01 jd-extract + 0.01 match-score).
    // scoreConcurrency:1 makes the rolling pool strictly sequential, so the
    // per-slot cap gate is deterministic: job1 (spent 0→0.02) and job2
    // (0.02→0.04) both open under the 0.025 cap and score, but job3's gate
    // sees 0.04 >= 0.025 and bails, as does job4 → 2 scored. The old batched
    // loop only checked BETWEEN batches of 3, so it scored all 3 of batch 1;
    // this asserts the per-job gate the rolling pool restores.
    const postings: RawPosting[] = [
      { sourceId: good.id, url: "https://example.com/jobs/cap-1", title: "Data Engineer", company: "Acme", location: "Remote", description: "Build data pipelines with SQL." },
      { sourceId: good.id, url: "https://example.com/jobs/cap-2", title: "Data Engineer", company: "Beta Corp", location: "Remote", description: "Build more data pipelines with SQL." },
      { sourceId: good.id, url: "https://example.com/jobs/cap-3", title: "Data Engineer", company: "Gamma Corp", location: "Remote", description: "Build even more data pipelines with SQL." },
      { sourceId: good.id, url: "https://example.com/jobs/cap-4", title: "Data Engineer", company: "Delta Corp", location: "Remote", description: "Build data pipelines yet again with SQL." },
    ];

    const run = await startSearch(BOOTSTRAP_ADMIN_ID,
      { persona: "remote" },
      { llm: costingLlm, dailyCapUsd: 0.025, scoreConcurrency: 1, connectorForSource: (source) => stubConnector(source, postings) },
    );

    const finalRow = await waitForTerminal(runsRepo, run.id);
    expect(finalRow.status).toBe("completed");
    expect(finalRow.stats.matched).toBe(4);
    expect(finalRow.stats.scored).toBe(2); // per-job gate stops after 2, not 3
    expect(finalRow.stats.capStopped).toBe(true);
  });
```

Also refresh the now-stale name + comment of the next test (~`:563`) — assertions are unchanged, only wording:

```ts
  it("rolling pool: every candidate is scored, aggregating a mix of success and EmptyJobDescriptionError", async () => {
```

and change its inline comment `// 3 candidates (one SCORE_BATCH_SIZE batch): 2 with a description ...` to `// 3 candidates through the rolling pool: 2 with a description score ...`.

- [ ] **Step 3: Run the cap test to verify it fails**

Run: `npx vitest run src/server/search/run.test.ts -t "per-job gate"`
Expected: FAIL — `expected 3 to be 2` (the current batched loop scores all 3 of batch 1; it also ignores the new `scoreConcurrency` dep).

- [ ] **Step 4: Replace the batch loop with a rolling pool**

In `src/server/search/run.ts`, change the constant near the top (`:33`):

```ts
const SCORE_CONCURRENCY = 3; // rolling scoring pool width — each match-score call is observed at 25-60s
```

(Delete the old `const SCORE_BATCH_SIZE = 3; ...` line.)

Then replace the body of `scoreTopCandidates` from the `handle.emit({ event: "progress", ... "score" ... })` "Scoring N job(s)…" emit through the end of the batch `for` loop (i.e. `run.ts:435-501`, the initial score-progress emit + the `let doneCount = 0;` + the whole `for (let i = 0; ...)` batch loop) with:

```ts
  const scoreConcurrency = deps.scoreConcurrency ?? SCORE_CONCURRENCY;

  handle.emit({
    event: "progress",
    data: { stage: "score", current: 0, total: topCandidates.length, label: `Scoring ${topCandidates.length} job(s)…` },
  });

  // Rolling concurrency pool (was task-7b batched Promise.all-per-3): up to
  // `scoreConcurrency` jobs score at once and a finished slot immediately
  // pulls the next candidate — no batch barrier idling a fast job behind its
  // slow neighbours. The daily-cap gate is checked as each slot OPENS (per
  // job): once running spend crosses the cap every not-yet-started job bails
  // WITHOUT spending; the ≤ scoreConcurrency-1 in-flight jobs still finish, so
  // overshoot is bounded by the pool width, not a full batch. `scored`/etc.
  // mutate safely because JS runs these callbacks on one thread — only the
  // awaits interleave, never the counter increments.
  const limit = pLimit(scoreConcurrency);
  let doneCount = 0;
  await Promise.all(
    topCandidates.map(({ job, source }) =>
      limit(async () => {
        if (dailyCapUsd !== undefined && spentToday >= dailyCapUsd) {
          capStopped = true;
          return;
        }
        try {
          const jobToScore = await ensureDescription(job, source).catch((err) => {
            console.error(`search run ${row.id}: detail fetch for job ${job.id} failed:`, err);
            return job; // scoreJob will throw EmptyJobDescriptionError -> counted unscored
          });
          const scoreRow = await scoreJob({ job: jobToScore, source, profile, resume, llm });
          spentToday += scoreRow.costUsd;
          scored += 1;
          if (scoreRow.verdict === "Apply" || scoreRow.verdict === "Consider") worth += 1;
          if (scoreRow.legitimacy.tier === "ghost") ghosts += 1;

          handle.emit({ event: "job", data: assembleJob({ job, score: scoreRow, source }, { isNewCutoff }) });
        } catch (err) {
          if (err instanceof EmptyJobDescriptionError) {
            unscored += 1;
          } else {
            // A single job's scoring failure (LLM error, malformed response,
            // or an aborted call once the hard cap fires — Task 2) is tolerated
            // exactly like a connector failure: the run keeps going.
            console.error(`search run ${row.id}: scoring job ${job.id} failed:`, err);
          }
        } finally {
          doneCount += 1;
          handle.emit({
            event: "progress",
            data: {
              stage: "score",
              current: doneCount,
              total: topCandidates.length,
              label: `${doneCount}/${topCandidates.length} scored`,
            },
          });
        }
      }),
    ),
  );
```

Leave the trailing `handle.emit({ ... stage: "legitimacy" ... })` and `return { scored, worth, ghosts, unscored, capStopped };` exactly as they are.

- [ ] **Step 5: Run the run suite to verify all tests pass**

Run: `npx vitest run src/server/search/run.test.ts`
Expected: PASS — all tests green, including the rewritten `per-job gate` cap test (`scored === 2`) and the unchanged `rolling pool` aggregation test (`scored === 2`, `unscored === 1`).

- [ ] **Step 6: Commit**

```bash
git add src/server/search/run.ts src/server/search/run.test.ts
git commit -m "refactor(search): rolling pLimit scoring pool with per-job cap gate"
```

---

### Task 2: Hard-cap timer covers scoring + abort signal threaded to the LLM

Today the worst-case abort timer is cleared right after discovery (`run.ts:262`), and `handle.signal` never reaches the LLM client — so a hung scoring phase runs forever and holds the persona mutex until process restart. Extend the timer over scoring (clear it in a `finally`) and thread `handle.signal` through `scoreJob → extractJdFacts / scoreMatch → llm.complete`, so a fired cap actually cancels the in-flight LLM call. An aborted call is tolerated the same way a per-job failure is (Task 1), so the run finishes and releases its slot instead of wedging.

**Files:**
- Modify: `src/server/score/evalScores.ts` (`scoreMatch` gains `signal?`)
- Modify: `src/server/score/jdFacts.ts` (`extractJdFacts` gains `signal?`)
- Modify: `src/server/score/index.ts` (`scoreJob` args gain `signal?`, forwarded to both calls)
- Modify: `src/server/search/run.ts` (wrap the `runFanOut` body after the timer in `try { … } finally { clearTimeout(hardCapTimer) }`; pass `signal: handle.signal` to `scoreJob`)
- Test: `src/server/search/run.test.ts` (add a `hangingLlm` + one new test)

**Interfaces:**
- Consumes: `LlmClient.complete({ …, signal?: AbortSignal })` (already supported, `client.ts:30`); `RunHandle.signal` (already exists, `registry.ts:26`).
- Produces:
  - `scoreMatch(llm, vars, modelOverride?, signal?: AbortSignal)`
  - `extractJdFacts(llm, description, signal?: AbortSignal)`
  - `scoreJob(args: { …, signal?: AbortSignal })`

- [ ] **Step 1: Add the failing "hung scoring aborts" test**

In `src/server/search/run.test.ts`, add this module-level mock next to `costingLlm` (after `:95`):

```ts
// A match-score LlmClient that never settles on its own — it resolves ONLY
// when its AbortSignal fires. Proves (a) the hard-cap timer stays armed
// through the scoring phase and (b) handle.signal is threaded all the way to
// the LLM call. Under the pre-M0 code (timer cleared after discovery, signal
// not threaded) `args.signal` is undefined here, so this hangs until the
// test's waitForTerminal deadline and the test fails.
const hangingLlm: LlmClient = {
  async complete(args) {
    if (args.signal?.aborted) throw new Error("llm call aborted (hard runtime cap)");
    return new Promise<never>((_resolve, reject) => {
      args.signal?.addEventListener("abort", () => reject(new Error("llm call aborted (hard runtime cap)")));
    });
  },
};
```

Then add this test inside the `describe("startSearch", …)` block (e.g. after the hard-runtime-cap connector test ~`:414`):

```ts
  it("hard runtime cap covers scoring: a hung LLM call is aborted, the run still completes and releases its persona slot", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });

    const posting: RawPosting = {
      sourceId: good.id,
      url: "https://example.com/jobs/hang",
      title: "Data Engineer",
      company: "Acme",
      location: "Remote",
      description: "Build data pipelines with SQL.",
    };

    // Discovery finishes instantly (array stub); scoring then hangs in the
    // first LLM call (jd-extract). The 100ms hard cap must fire DURING scoring
    // — impossible under the pre-M0 code, which cleared the timer after
    // discovery — abort the LLM call, and let the run complete (0 scored).
    const run = await startSearch(BOOTSTRAP_ADMIN_ID,
      { persona: "remote" },
      { llm: hangingLlm, hardRunTimeoutMs: 100, connectorForSource: (source) => stubConnector(source, [posting]) },
    );

    const finalRow = await waitForTerminal(runsRepo, run.id);
    expect(finalRow.status).toBe("completed");
    expect(finalRow.stats.scored).toBe(0);
    expect(getActiveRunForPersona(BOOTSTRAP_ADMIN_ID, "remote")).toBeUndefined();
  });
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npx vitest run src/server/search/run.test.ts -t "hard runtime cap covers scoring"`
Expected: FAIL — `run … did not reach a terminal state within the test timeout` (the timer is cleared after discovery and the signal is not threaded, so the hung LLM call never aborts and the run stays `running`).

- [ ] **Step 3: Thread the signal through `scoreMatch`**

In `src/server/score/evalScores.ts`, change `scoreMatch` to accept and forward a signal:

```ts
export async function scoreMatch(
  llm: LlmClient,
  vars: { jdFacts: unknown; resume: unknown },
  modelOverride?: string,
  signal?: AbortSignal,
): Promise<{ data: EvalScores; model: string; costUsd: number }> {
  return llm.complete({
    task: "match-score",
    modelOverride,
    messages: renderTemplate("match-score", {
      jdFacts: JSON.stringify(vars.jdFacts),
      resume: JSON.stringify(vars.resume),
    }),
    responseSchema: EvalScoresSchema,
    signal,
  });
}
```

- [ ] **Step 4: Thread the signal through `extractJdFacts`**

In `src/server/score/jdFacts.ts`, change `extractJdFacts` (leave `extractJdFactsForGate` untouched — it's the url-check path, not the scan):

```ts
export async function extractJdFacts(
  llm: LlmClient,
  description: string,
  signal?: AbortSignal,
): Promise<{ data: JdFacts; model: string; costUsd: number }> {
  const raw = await llm.complete({
    task: "jd-extract",
    messages: renderTemplate("jd-extract", { jobDescription: description }),
    responseSchema: JdFactsEmitSchema,
    signal,
  });
  return { ...raw, data: emitToFacts(raw.data) };
}
```

- [ ] **Step 5: Thread the signal through `scoreJob`**

In `src/server/score/index.ts`, add `signal` to the args and forward it to the three LLM calls. Change the args type (add one line after `webEvidence?`):

```ts
  webEvidence?: WebEvidence | Promise<WebEvidence>;
  // Run-scoped cancellation (server/search/run.ts hard cap). Forwarded to the
  // jd-extract + match-score LLM calls so a fired cap actually cancels them.
  signal?: AbortSignal;
}): Promise<JobScoreRow> {
```

Change the jd-extract call (`:54-56`):

```ts
  const jdFactsResult = args.precomputedJdFacts
    ? { data: args.precomputedJdFacts, model: "precomputed", costUsd: 0 }
    : await extractJdFacts(llm, job.description, args.signal);
```

Change the cheap match-score call (`:75`):

```ts
  const cheap = await scoreMatch(llm, { jdFacts: jdFactsResult.data, resume: resume.structured }, undefined, args.signal);
```

Change the escalation match-score call (`:82`):

```ts
        const strong = await scoreMatch(llm, { jdFacts: jdFactsResult.data, resume: resume.structured }, escalateModel, args.signal);
```

- [ ] **Step 6: Extend the hard-cap timer over scoring and pass the signal into the pool**

In `src/server/search/run.ts`, inside the pool callback from Task 1, add the signal to the `scoreJob` call:

```ts
          const scoreRow = await scoreJob({ job: jobToScore, source, profile, resume, llm, signal: handle.signal });
```

Then change the timer lifetime. Currently `run.ts` clears the timer right after discovery:

```ts
  await Promise.all(tasks);
  clearTimeout(hardCapTimer);
```

Remove that `clearTimeout(hardCapTimer);` line, and wrap everything from just after the `setTimeout` to the end of `runFanOut` in a `try/finally` that clears the timer. Concretely, the structure becomes:

```ts
  const hardCapTimer = setTimeout(() => handle.abort("hard runtime cap exceeded"), hardRunTimeoutMs);

  try {
    const targets = deriveRoleTargets(resumeRow, persona);
    // … everything currently between here and the `done` emit, UNCHANGED …
    await Promise.all(tasks);

    const upsertedJobs = await upsertMatchedPostings(userId, matchedPostings, persona, profile);
    const { scored, worth, ghosts, unscored, capStopped } = await scoreTopCandidates(
      userId, row, upsertedJobs, resumeRow, persona, profile, handle, deps,
    );

    const stats = {
      scanned,
      matched: matchedPostings.length,
      scored, worth, ghosts,
      perSource: [...perSource.entries()].map(([sourceId, s]) => ({ sourceId, found: s.found, errors: s.errors })),
      unscored,
      capStopped,
    };
    await searchRunsRepo.updateStats(row.id, stats);
    const finished = await searchRunsRepo.updateStatus(row.id, "completed", { finishedAt: new Date() });

    release(row.id, userId, persona);
    const finalRow = finished ?? (await searchRunsRepo.getById(row.id, userId));
    if (!finalRow) throw new Error(`search_runs row ${row.id} vanished before completion could be recorded`);
    handle.emit({ event: "done", data: toSearchRun(finalRow) });
  } finally {
    // The timer now spans discovery AND scoring; the finally clears it on
    // every exit path (success, or a throw that propagates to startSearch's
    // failRun net) so it never dangles to abort a run that already finished.
    clearTimeout(hardCapTimer);
  }
```

(Only the timer scope and the `scoreJob` signal argument change — the discovery task setup, `perSource` map, counters, and emits are moved verbatim inside the `try`, not edited.)

- [ ] **Step 7: Run the new test to verify it passes**

Run: `npx vitest run src/server/search/run.test.ts -t "hard runtime cap covers scoring"`
Expected: PASS — the 100ms cap fires during scoring, aborts the hung jd-extract call, the run reaches `completed` with `scored === 0`, and the persona slot is released.

- [ ] **Step 8: Run the full run suite to verify no regressions**

Run: `npx vitest run src/server/search/run.test.ts`
Expected: PASS — all tests green (the pre-existing discovery hard-cap test still completes with `perSource errors: 1`; the B6 SSE-order test still ends `…progress(legitimacy), done`).

- [ ] **Step 9: Commit**

```bash
git add src/server/score/evalScores.ts src/server/score/jdFacts.ts src/server/score/index.ts src/server/search/run.ts src/server/search/run.test.ts
git commit -m "fix(search): hard cap covers scoring + thread abort signal into scoring LLM calls"
```

---

### Task 3: Full-gate verification

- [ ] **Step 1: Run the complete check gate**

Run: `npm run check`
Expected: PASS — typecheck (the new `signal?` params and `scoreConcurrency` dep type-check across all call sites, including the url-check pipeline which calls `scoreJob`/`extractJdFacts` without a signal), full vitest suite, contract check (no wire-type changes in M0), and build.

- [ ] **Step 2: Confirm no unintended call-site breakage**

Run: `git grep -n "scoreMatch(\|extractJdFacts(\|scoreJob(" -- src`
Expected: every call site still compiles — the three signatures only ADD an optional trailing/last param, so existing callers (notably the url-check worker `src/server/url-check/*` and any `evaluate` route) are unaffected. If `npm run check` flagged one, fix it by leaving its call unchanged (the new param is optional).

---

## Deferred out of M0 (tracked, intentional)

- **`failRun` persisting accumulated stats / partial results** — moved to **M1**, where incremental writes make the `search_runs` row reflect live progress, so a failed/partial run's history is durable without hoisting counters. M0 does not increase failure frequency (an aborted scoring call is tolerated → the run completes), so deferring this causes no regression: failed runs continue to show zeroed stats exactly as before M0.
- **`probeLivenessDeep` abort** — the liveness probe is a fast HEAD-style check, not the 20–60s hang risk; threading its cancellation is out of scope. The dominant hang (the LLM calls) is covered.
- **Event-vocabulary changes** (`source` / `jobPhase` / removing the decorative `legitimacy` progress stage) — those belong to **M2**; M0 keeps the existing `progress` events so the client and its tests are untouched.

## Self-Review

- **Spec coverage (M0 slice of §4.2):** rolling `pLimit(3)` pool → Task 1; per-job cap gate → Task 1 (test asserts `scored === 2`); hard-cap timer covers scoring → Task 2 (test red under old code); abort signal threaded to the LLM client → Task 2 Steps 3–6; pinned cap test reverted to per-job semantics → Task 1 Step 2. `failRun` stats → explicitly deferred to M1 with rationale (above).
- **Placeholder scan:** none — every code step shows the full replacement text and every run step shows the exact command + expected result.
- **Type consistency:** `scoreConcurrency` (added Task 1 Step 1, consumed Task 1 Step 4); `signal?: AbortSignal` added to `scoreMatch`/`extractJdFacts`/`scoreJob` (Task 2 Steps 3–5) and consumed at the pool call site (Task 2 Step 6); `handle.signal` and `LlmClient.complete({ signal })` are pre-existing. `SCORE_BATCH_SIZE` is fully removed and replaced by `SCORE_CONCURRENCY` (Task 1 Step 4) — no dangling reference.
