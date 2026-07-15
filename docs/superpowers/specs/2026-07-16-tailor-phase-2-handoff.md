# Tailor Correlation Engine — Phase 2 handoff

**Date:** 2026-07-16
**Status:** handoff (NOT a spec — Phase 2 needs its own brainstorm → spec → plan cycle)
**Predecessor:** `docs/superpowers/specs/2026-07-15-tailor-correlation-engine-design.md` (esp. §2 principles, §11 open questions)
**Phase 1 ledger:** `.superpowers/sdd/progress.md` on branch `feat/tailor-correlation-engine`

## 1. Where Phase 1 left things

Phase 1 shipped the full backend: a correlation engine (`src/server/tailor/correlate.ts`,
extract → classify → verify) producing a persisted `CorrelationReport`; a report-driven,
**edits-only allowlist rewrite** (`src/server/tailor/index.ts` — the model emits addressable
edits, `structured` is derived via `applyEdits`, and any edit citing a requirement outside the
met/buried allowlist fails loud); deterministic guards (`verifyEvidence` quote containment,
`fabricationViolations` numeric atoms, before-anchor-mandatory merge); and a full eval harness
(`npm run eval:tailor`, 3 goldens, deterministic metrics in `npm test`). Crucially: **the
existing `/jobs/[id]/tailor` page (`src/app/(app)/jobs/[id]/tailor/page.tsx`) still works** —
its "Generate" hits `POST /api/tailor` with no `reportId`, which auto-correlates then rewrites
(stages `correlate → rewrite → render → done`). Phase 1 is dormant-but-safe backend depth, not
a user-visible change. The report and its two signals exist in the DB and the API but nothing
renders them yet.

## 2. Phase 2 scope (from design §11)

Each of these is a sub-goal a brainstorm can pick up independently.

### 2a. The "measure, then rewrite" report UI
The core Phase 2 deliverable. Render the `CorrelationReport`:
- **Per-requirement rows** — each `CorrelationRow` carries `requirement`, `term`, `kind`
  (`must | nice | responsibility`), `status` (`met | buried | gap`), verbatim `evidence`
  quote (non-null iff met/buried), `atsPresent`, `reason`, `note`. Show status + evidence +
  reason per row; the quote is the audit trail.
- **Two labelled signals, never a fused hero %** (design §2, non-negotiable):
  `semantic` rendered as `met+buried of total` (n-of-m with evidence) and `ats` rendered as
  `present of total` (+ `missing` terms list). No single percentage exists in the contract
  and none should be invented in the UI.
- **Per-row rewrite affordances** — the user reviews the report, then triggers the rewrite
  via `POST /api/tailor { jobId, reportId }` (reportId is pre-validated synchronously →
  `UnknownReportError` → 404). Each resulting `diff[]` entry carries its `requirement` and
  `target: { index, bulletIndex }`, so edits map back to report rows for review/accept.
- **Open question:** does the report get its own screen or fold into the existing tailor
  page? (See §6.)

### 2b. Eligibility/knockout + legitimacy pre-gates
Before the user invests in tailoring:
- Surface `hiringScope` / `hiringCountries` / `tzRequirement` — already extracted into
  `JdFactsSchema` (`src/server/score/jdFacts.ts`) and consumed by
  `src/server/score/eligibility.ts`. No new extraction needed; this is surfacing + gating.
- Warn/block tailoring when the job's `legitimacy` is `suspicious | ghost | scam`. This is
  brand-coherent: legitimacy is Caliber's wedge, and "don't waste effort tailoring for a
  ghost job" extends it naturally.
- Design §11 notes the report payload has room for these; enforcement point (API vs UI vs
  both) is a brainstorm question (§6).

### 2c. Embeddings / LLM-judge fit scoring — IF NEEDED only
Explicitly deferred, not a default Phase 2 item. Revisit only if the deterministic +
verified-quote signal proves insufficient against the growing golden set (growth rule:
every prod misclassification joins `src/server/tailor/__fixtures__/golden/`). Design §2's
rationale stands: a verified quote explains itself; "0.71 similarity" does not, and
OpenRouter is chat-completions only.

### 2d. Post-merge ATS before→after delta
The one design §6 item deferred with **no contract field** (ledger, Task 10 scope-out):
after applying accepted edits, recompute the literal ATS check on the merged résumé and
show the `ats.present` before→after delta — the stable, non-LLM proof the rewrite worked.
Phase 2 must decide its home (a field on `TailoredResume`? computed at finalize?) and its
surfacing. Task 12's eval harness covers ATS non-regression in the interim, so this is
measurement UX, not a safety gap.

## 3. Hardening backlog (deferred non-blocking follow-ups, ranked)

From the final whole-branch review triage in `.superpowers/sdd/progress.md`:

1. **`fabricationViolations` is numeric-only** — design §6 also names employer names and
   certification/credential names as protected atoms; only numeric metrics/percentages/year
   ranges are guarded today (`src/server/tailor/correlate-metrics.ts`). **RESIDUAL (highest
   value):** non-numeric semantic fabrication under an allowlisted requirement passes all
   deterministic guards — bounded only by the template instructions and the human accept
   gate. Adding employer/cert atom extraction is the highest-value hardening.
2. **`buildRequirements` requirement-text non-uniqueness** — requirement text is the join
   key between report rows and diff edits; duplicate text across mustHaves/niceToHaves/
   responsibilities would be ambiguous. Dedupe follow-up.
3. **`jdFacts` unvalidated cast** — `correlate.ts` reads `scoreRow.jdFacts` via `as JdFacts`;
   should be parse-at-read (`JdFactsSchema.parse`) per fail-loud policy.
4. **Run-handle eviction** — correlate (and pre-existing tailor) run handles are never
   evicted from the registry map; fix registry-wide, not per-feature.
5. **`correlationReports.getById` omits `.limit(1)`** — harmless (PK lookup) but breaks the
   `tailoredResumes` repo precedent.
6. Minor triage items: redundant sync+async `getById` in startTailor (deliberate fail-fast);
   golden-01 "Operate production services" buried-vs-met label (watch when calibrating
   `eval:tailor` live); `toCorrelationReport` zeros-vs-fail-loud on queued/running rows.

## 4. Backend contract the UI can rely on

All shapes are Zod in `src/types/index.ts`; routes registered in `src/contract/registry.ts`
and documented in `docs/architecture/api-contract.md`.

- **`CorrelationRow`** — `{ requirement, term, kind: 'must'|'nice'|'responsibility',
  status: 'met'|'buried'|'gap', evidence: string|null, atsPresent: boolean, reason,
  note: string|null }`.
- **`CorrelationReport`** — `{ id, jobId, resumeId, status, progress, rows[],
  semantic: { met, buried, gap, total }, ats: { present, total, missing[] }, model,
  costUsd, createdAt, completedAt }`. No headline percentage field — by design.
- **`TailoredResume`** — gains `reportId: string|null`; each `diff[]` entry carries
  `requirement` and `target: { index: number|null, bulletIndex: number|null }` plus
  `section/op/before/after/reason`. `before` is mandatory for `modify` (WYSIWYG anchor).
- **Routes** — `POST /api/tailor/correlate { jobId }` → 202 report (409 no résumé / no
  jdFacts "score this job first", 404 unknown job); `GET /api/tailor/correlate/:id` →
  report, SSE stages `extract → classify → verify → done`; `POST /api/tailor
  { jobId, reportId? }` (omitted reportId auto-correlates), stages
  `correlate → rewrite → render → done`; `GET /api/tailor/:id`, `finalize`, `pdf` unchanged.
- **Classifier prompt** — `config/templates/correlate.md`; `correlate` task in
  `config/models.yml` (cheap tier).
- **The key invariant, a UX asset:** a wrong "you don't have X" can only come from the
  classifier, never from silent verifier failure — the verifier only *downgrades* unverifiable
  claims to `gap` with a recorded note, and every met/buried row carries a verbatim quote that
  actually occurs in the résumé. Every row is auditable: the UI can always show the user *why*
  a row says what it says, and the fix path (report a misclassification → golden set) is built
  into the eval growth rule.

## 5. Process note

This document is a handoff, not a spec. Phase 2 must run its own
brainstorm → spec → plan cycle (superpowers flow) before any implementation. The scope
items in §2 are sub-goals to structure that brainstorm, not commitments.

## 6. Open design questions for the Phase 2 brainstorm

1. **Report screen vs inline** — does the correlation report get its own screen/route, or
   fold into the existing `/jobs/[id]/tailor` page as a pre-rewrite step?
2. **Presenting two signals honestly without a percentage** — how do we make
   `semantic met+buried of total` and `ats present of total` legible and comparable while
   keeping the no-fused-% principle? (Labelled meters? Two n-of-m rows? How do we stop
   users mentally averaging them?)
3. **Auto-rewrite-all vs per-row** — one "rewrite everything targetable" action, per-row
   rewrite triggers, or select-rows-then-rewrite? (The API today rewrites all met/buried
   candidates for a report; per-row would need contract work.)
4. **Where does the eligibility/legitimacy gate live** — in the correlate API (409/warn
   payload), the report UI (banner before rewrite), the jobs list (don't offer tailor at
   all), or layered? Hard block vs dismissible warning per legitimacy tier?
5. **Never-scored jobs** — design §7 defers self-extraction of jdFacts; does Phase 2 lift
   the "score this job first" 409 by extracting jdFacts inline, or keep the scoring
   prerequisite as a deliberate funnel?
6. **ATS delta home** — where the §2d before→after delta lives in the contract and where
   it renders (finalize screen? tracker?).
