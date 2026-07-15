# Tailor Correlation Engine — design spec

**Date:** 2026-07-15
**Feature area:** F6 résumé tailoring
**Status:** design, pre-implementation
**Phase:** 1 (backend framework + full algorithm eval harness; no UI redesign)

## 1. Problem

The current tailor feature (`src/server/tailor/index.ts`, `config/templates/tailor.md`) is a
one-shot rewriter with **no model of the résumé↔JD relationship**:

- The only "what to emphasize" signal is `jdFacts` + `gaps` pulled from the latest
  `match-score` run (`jobScoresRepo.getLatestByJobId`). If the job was never scored the
  prompt literally receives `"Not available — this job has not been scored yet."` — a
  fallback default in a fail-loud codebase.
- **Staleness bug (live):** `getLatestByJobId` returns the newest score row with no check
  that its `resumeId` matches the currently-active résumé `startTailor` independently
  fetched. Re-upload a résumé, tailor a previously-scored job → the rewrite is driven by
  the *old* résumé's `gaps`.
- No correlation is computed by tailor itself; nothing measures how the résumé matches the
  JD, and nothing verifies the tailoring improved the match.
- The diff is hard-capped at **one entry per section** (a `superRefine` in
  `TailorResultSchema`, existing only to patch the same-section merge hazard in `merge.ts`),
  so edits are coarse blobs.
- The sole anti-fabrication guardrail is one prompt sentence — no per-claim traceback to a
  résumé quote (the `answer-questions` feature already does this: "every claim traces to
  the résumé").

Research (donor `career-ops/modes/tailor-cv.md`; Jobscan / Teal / Rezi / Synapse 2026)
converges on: fit is **multi-dimensional and decomposed, never one opaque number**;
credible tools pair a **keyword/requirement gap report** with a **constrained, bullet-level
rewrite of existing content**; honest tailoring = reword real experience in JD vocabulary,
surface buried skills, quantify, reorder — never invent; unmet requirements are shown as
gaps, not written into the résumé.

## 2. Core principle — the inversion

Put the determinism in the **verifier, not the matcher.**

- A **cheap LLM classifier** compares each JD requirement to the résumé and, for any
  "the candidate has this" claim, **must emit a verbatim résumé quote** as evidence.
- **Deterministic code** then verifies that quote actually occurs in the résumé (normalized
  fuzzy-contain) and **fails loud** otherwise. This is the same mechanism as
  `containmentViolations` in `src/server/resume/eval-metrics.ts`.
- Two signals are produced and kept **separate, never fused into one hero %**:
  1. **Semantic requirement coverage** — LLM-classified, quote-verified, presented as an
     `n-of-m` list with evidence (self-correcting: the user sees *why* each row says what it
     says).
  2. **Literal ATS keyword presence** — pure deterministic string check on each
     requirement's canonical `term`. Its before→after delta is the **stable regression
     anchor** (LLM re-measurement is test-retest noisy).

Embeddings are **deferred**: OpenRouter is chat-completions only, and the verified-quote
pass buys more semantic accuracy *and* auditability than a cosine threshold ("0.71 similarity"
explains nothing; a quote does). The LLM classifier also handles Bahasa/JobStreet
cross-language equivalence natively, which lexical matching cannot.

## 3. Goals / non-goals (Phase 1)

**In scope**
1. A **correlation engine** (`server/tailor/correlate`): requirement extraction consumption →
   LLM-classify-with-quote → deterministic quote-verifier → decomposed semantic signal +
   literal ATS signal. Produces a persisted **CorrelationReport**.
2. A **correlation-driven rewrite** (`server/tailor` rework): rewrite is driven by and
   constrained to the report; edits are **addressable at bullet granularity**, individually
   reviewable, each traceable to a requirement row; genuine gaps are never written into
   content. Retires the one-entry-per-section constraint.
3. **Tailor owns its jdFacts** (résumé-independent), computing correlation fresh from
   `(active résumé, jdFacts)`. Kills the staleness bug and the `"Not available"` fallback.
4. A **full eval harness** mirroring the résumé-extraction harness: golden fixtures,
   live-gated classifier eval with scored metrics, deterministic verifier/guard unit tests,
   `npm run eval:tailor`, and the growth rule.

**Out of scope (Phase 2+)**
- The redesigned report UI and per-row rewrite affordances (backend exposes the capability;
  no React work here).
- Eligibility/knockout and legitimacy pre-gates (the report payload leaves room for them;
  enforcement + UI are Phase 2).
- Embeddings, LLM-judge fit scoring, LLM-based re-measurement.

## 4. Data model & contract

New Zod types in `src/types/index.ts` (mirrored into `docs/architecture/api-contract.md`):

```ts
export const RequirementStatus = z.enum(['met', 'buried', 'gap']);
// met   = satisfied AND surfaced (evidence present, prominent)
// buried = evidence exists but not surfaced/emphasized  -> rewrite target
// gap   = résumé cannot honestly support it              -> never written into content

export const CorrelationRow = z.object({
  requirement: z.string(),                       // JD requirement sentence, verbatim from jdFacts
  term: z.string(),                              // canonical 1-3 word atom for the literal ATS check
  kind: z.enum(['must', 'nice', 'responsibility']),  // provenance: jdFacts.mustHaves / niceToHaves / responsibilities
  status: RequirementStatus,
  evidence: z.string().nullable(),               // verbatim résumé quote; non-null iff status ∈ {met, buried}
  atsPresent: z.boolean(),                       // deterministic: `term` occurs (normalized) in the résumé
  reason: z.string(),                            // one-line why
  note: z.string().nullable(),                   // for gap: optional "supportable via X" note; else null
});

export const CorrelationReport = z.object({
  id: z.string(), jobId: z.string(), resumeId: z.string(),
  status: RunStatus, progress: Progress.nullable(),
  rows: z.array(CorrelationRow),
  semantic: z.object({ met: z.number().int(), buried: z.number().int(),
                       gap: z.number().int(), total: z.number().int() }),
  ats: z.object({ present: z.number().int(), total: z.number().int(),
                  missing: z.array(z.string()) }),   // missing `term`s
  model: z.string(), costUsd: z.number().nullable(),
  createdAt: z.string().datetime(), completedAt: z.string().datetime().nullable(),
});
```

**No headline percentage field.** Consumers render `semantic` as `met+buried of total` and
`ats` as `present of total`, two labelled signals. A single fused % is explicitly excluded.

**TailoredResume** (`src/types`) changes:
- add `reportId: z.string().nullable()` — the report this rewrite was driven by (nullable to
  admit legacy rows predating this migration).
- `diff[]` entry gains addressing + traceability:
  ```ts
  { section, op, before?, after?, reason,
    requirement: z.string(),                     // the CorrelationRow.requirement this edit serves
    target: z.object({ index: z.number().int().nullable(),      // experience[]/projects[]/skills[] index, else null
                       bulletIndex: z.number().int().nullable() }) // bullet/item within that entry, else null
  }
  // `section` names the ResumeStore field ('summary'|'headline'|'experience'|'projects'|'skills');
  // scalar sections use index=null, bulletIndex=null.
  ```
- The one-entry-per-section `superRefine` in `TailorResultSchema` is **removed**; multiple
  edits per section are now valid because each targets a distinct addressable location.
- The rewrite model emits **edits only** (`{ diff: Edit[] }`) — not a full tailored ResumeStore.
  The tailored `structured` is *derived* server-side by applying all edits to the base résumé
  (`applyEdits`), so the model cannot rewrite un-targeted content and every change is an
  addressable, reviewable edit.

**Persistence** (`src/server/persistence/schema.ts`, new Drizzle migration):
- New table `correlation_reports`: `id, userId FK, jobId FK, resumeId FK, rows jsonb,
  semantic jsonb, ats jsonb, status, model, costUsd, createdAt, completedAt`. Same per-user
  scoping as every other user-owned table (`user_id NOT NULL`, userId-scoped repo).
- `tailored_resumes` gains `report_id FK → correlation_reports` (nullable for legacy rows).

**API surface** (`docs/architecture/api-contract.md`):
- `POST /api/tailor/correlate` — `{ jobId }` → `202 CorrelationReport` (queued). `404` unknown
  job, `409` no active résumé.
- `GET /api/tailor/correlate/:id` — `200 CorrelationReport | 404`; SSE via Accept header.
  Stages: `extract → classify → verify → done`.
- `POST /api/tailor` — now `{ jobId, reportId? }`. If `reportId` omitted, the run computes a
  correlation first (same engine), then rewrites. `404` unknown job/report, `409` no résumé.
  Stages become `correlate → rewrite → render → done`.
- `GET /api/tailor/:id`, `POST /api/tailor/:id/finalize`, `GET /api/tailor/:id/pdf` — unchanged
  surface; finalize's `acceptedIndices` now index the finer row-scoped `diff[]`.

## 5. Correlation engine (`src/server/tailor/correlate.ts`)

`correlate(userId, { jobId }, deps)` → persists a `correlation_reports` row, runs async:

1. **extract** — obtain `jdFacts` for the job (§7). Requirement atoms = `mustHaves` (kind
   `must`) + `niceToHaves` (`nice`) + `responsibilities` (`responsibility`). No new extraction
   template; reuse `extractJdFacts`.
2. **classify** — one LLM call, new template `config/templates/correlate.md`, cheap tier (new
   `correlate` task in `config/models.yml`, same model as other cheap tasks, low `maxTokens`).
   Input: the requirement list + résumé structured JSON. Output (emit-schema, nullable-safe per
   the gpt-oss-120b `.optional()`-drop rule): per requirement → `{ term, status, evidence,
   reason, note }`.
3. **verify (deterministic, fail-loud)** — `verifyEvidence(rows, resume)`:
   - For every row with `status ∈ {met, buried}`, `evidence` must be non-null and fuzzy-contain
     in the résumé (reuse the normalization behind `containmentViolations`). A violation
     **downgrades the row to `gap`** with a recorded `note` (`"evidence unverifiable"`) — the
     classifier is never trusted to assert coverage without a checkable quote.
   - `atsPresent` for each row is computed here deterministically: does the normalized `term`
     occur in the résumé text? This is independent of the LLM's semantic `status`.
   - Aggregate `semantic` counts and `ats` (present/total/missing) deterministically.

The `verify` step is pure code over `(rows, résumé)` — the primary unit-tested surface and the
"theory of correlation made testable."

## 6. Rewrite engine (`src/server/tailor/index.ts` rework)

`startTailor(userId, { jobId, reportId? }, deps)`:
- Resolve the report (given `reportId`, or run `correlate` inline).
- **rewrite** — the strong `tailor` tier, driven by the report. Only rows with
  `status ∈ {buried, met}` are rewrite candidates; `gap` rows are passed as an explicit
  "do-not-fabricate; these are gaps" list. New template `config/templates/tailor.md` (rewritten):
  for each targeted row, emit at most one **addressable, bullet-level edit** (`target` +
  before/after) that rewords existing content into the JD's `term` vocabulary and/or surfaces
  buried evidence, each carrying its `requirement` for traceability.
- **fabrication guard (deterministic, fail-loud)** — `fabricationViolations(edits, baseResume)`:
  an edit's `after` text may not introduce a **protected atom** absent from the base résumé —
  employer names, numeric metrics/percentages, year ranges, or certification/credential names.
  New vocabulary is permitted only when it is a JD `term`. Any violation fails the run
  (fail-loud), not silently drops.
- **merge** — `merge.ts` becomes bullet-addressable: `applyAcceptedDiff` applies each accepted
  edit to its `target` location instead of copying a whole section. This retires the
  one-entry-per-section hack and makes accept/reject genuinely per-edit.
- Re-run the deterministic **literal-ATS check** on the merged (accepted-all) résumé → the
  before→after `ats.present` delta is the stable, non-LLM measure that the rewrite worked.
  **Post-merge status: DEFERRED to Phase 2** — `index.ts` does not yet recompute this delta;
  Task 12's eval harness covers ATS non-regression in the interim.

Finalize / PDF paths are unchanged except that the merge is finer-grained.

## 7. Tailor owns its jdFacts (staleness fix)

`jdFacts` are **résumé-independent** (`JdFactsSchema` takes only the JD), so reusing the latest
job's `jdFacts` is safe; the staleness bug lived entirely in the résumé-dependent `gaps`
artifact, which we **stop using**. Behaviour:
- Fetch `jdFacts` from the latest `job_scores` row for the job (`jobScoresRepo.getLatestByJobId`).
  We read `jdFacts` **only** — never the résumé-dependent `gaps` artifact — so the latest row is
  safe regardless of which résumé produced it.
- No jdFacts → **fail loud with `409 CONFLICT` ("score this job first")**. The `"Not available"`
  fallback is removed entirely; the run never proceeds on a degraded/empty JD. (Self-extraction
  from the job's stored JD text, to allow tailoring a never-scored job, is a deliberate Phase-2
  follow-up — deferred to avoid coupling and an extra extraction cost here.)

## 8. Eval harness (full — mirrors `src/server/resume/eval.live.test.ts`)

- **Fixtures** — `src/server/tailor/__fixtures__/golden/*.json`, each:
  `{ id, category: 'real'|'synthetic', resume: <ResumeStore or rawText>, jdFacts: <JdFacts>,
    expected: { rows: [{ requirement, status }...] } }` — hand-labelled expected status per
  requirement. Include multilingual (Bahasa) and synonym/seniority/negation hazard cases
  (e.g. "Java"/"JavaScript", "migrating away from Angular", "7+ years leading").
- **Live classifier eval** — `src/server/tailor/correlate-eval.live.test.ts` (gated exactly
  like the résumé eval: excluded from `npm test`, included via `vitest.smoke.config.ts`, which
  already globs `src/**/*.live.test.ts`). For each golden: run the real classifier, then assert
  1. **quote-verifier: zero containment violations** — every `met`/`buried` evidence quote is
     found in the résumé (fail-loud), and
  2. **classifier accuracy** vs `expected`: per-row status match, with aggregate
     **`met`/`buried` precision** and **false-gap rate** meeting a calibrated baseline
     (`EVAL_BASELINE ± EVAL_EPSILON`, same convention as résumé eval).
- **Metrics module** — `src/server/tailor/correlate-metrics.ts`: pure functions
  (`verifyEvidence`, `statusAccuracy`, `falseGapRate`, `atsSignal`, `fabricationViolations`),
  unit-tested in `correlate-metrics.test.ts` with scripted fixtures (no LLM).
- **Rewrite eval** — extend the live test (or a sibling) to assert, per golden, after the
  driven rewrite: (a) zero `fabricationViolations`, (b) the literal-ATS `present` count **never
  regresses** and rises for targeted `buried` rows.
- **npm script** — `eval:tailor` → `vitest --config vitest.smoke.config.ts run
  src/server/tailor/correlate-eval.live.test.ts` (costs real tokens; documented in the runbook
  beside `eval:resume`).
- **Growth rule** — every résumé/JD pair that misclassifies in prod joins the golden set. The
  set only grows.

## 9. Files touched

**New**
- `src/server/tailor/correlate.ts` — engine (extract → classify → verify).
- `src/server/tailor/correlate-metrics.ts` + `.test.ts` — deterministic verifier/guard/scorers.
- `src/server/tailor/correlate-eval.live.test.ts` — live classifier + rewrite eval.
- `src/server/tailor/__fixtures__/golden/*.json` — golden set.
- `config/templates/correlate.md` — classifier prompt.
- `src/server/persistence/repos/correlationReports.ts` — repo (+ `.test.ts`).
- `src/app/api/tailor/correlate/route.ts` + `[id]/route.ts` (+ route tests).
- Drizzle migration — `correlation_reports` table + `tailored_resumes.report_id`.

**Changed**
- `config/templates/tailor.md` — rewritten as report-driven, addressable, bullet-level.
- `config/models.yml` — add `correlate` task.
- `src/server/tailor/index.ts` — report-driven rewrite, jdFacts ownership, fabrication guard,
  remove `"Not available"` fallback and the one-entry-per-section `superRefine`.
- `src/server/tailor/merge.ts` — bullet-addressable `applyAcceptedDiff`.
- `src/server/tailor/assemble.ts` — surface `reportId`; finer merge.
- `src/types/index.ts` + `docs/architecture/api-contract.md` — new types + contract deltas.
- `src/server/persistence/schema.ts` — table + column.
- Existing tailor tests updated for the new diff shape / stages.

## 10. Testing strategy

- **Deterministic core (default `npm test`):** `correlate-metrics.test.ts` (verify/guard/ATS
  scorers), `merge` bullet-addressing, repo round-trips, route status codes, updated
  `tailor.test.ts` / `finalize.test.ts` for the new stages and diff shape.
- **Algorithm eval (gated `npm run eval:tailor`, real LLM):** classifier accuracy + quote
  containment + rewrite non-regression over the golden set, with a calibrated baseline.
- **e2e (`e2e/tailor.spec.ts`):** updated for `correlate → rewrite` and per-edit accept/reject.

## 11. Open questions / Phase 2

- Eligibility/knockout + legitimacy pre-gates (surface `hiringScope`/`hiringCountries`/
  `tzRequirement` and block/warn on `suspicious|ghost|scam` before tailoring). The report
  payload has room; enforcement + UI deferred.
- The redesigned "measure, then rewrite" report UI and per-row rewrite affordances.
- Embeddings / LLM-judge fit scoring — only if the deterministic + verified-quote signal
  proves insufficient against the growing golden set.
