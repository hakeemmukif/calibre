# Tailor Phase 2 — correlation report UI + ATS delta — design spec

**Date:** 2026-07-16
**Feature area:** F6 résumé tailoring
**Status:** design, pre-implementation
**Phase:** 2 (this spec covers **sub-goals 2a + 2d only**)
**Predecessors:**
- `docs/superpowers/specs/2026-07-15-tailor-correlation-engine-design.md` (Phase 1 backend)
- `docs/superpowers/specs/2026-07-16-tailor-phase-2-handoff.md` (§2 scope, §6 open questions)

## 1. Problem / context

Phase 1 shipped the full correlation backend: `POST /api/tailor/correlate` produces a persisted
`CorrelationReport` (extract → LLM-classify-with-quote → deterministic verify), and the
report-driven, edits-only allowlist rewrite emits addressable `diff[]` entries each carrying a
`requirement` and a `target`. **But nothing renders the report.** The existing
`/jobs/[id]/tailor` page still runs the Phase-0 one-shot motion: "Generate" hits `POST /api/tailor`
with no `reportId`, auto-correlates silently, and drops the user straight into diff review. The
report and its two signals exist in the DB and the API but are invisible — so the "measure, then
rewrite" thesis (design §2) and the auditability wedge are unrealised.

Additionally, the design §6 **post-merge ATS before→after delta** (2d) was deferred with no
contract field: `finalizeTailor` computes the accepted merge but never re-measures it, so there is
no deterministic, non-LLM proof that the rewrite actually improved keyword coverage.

## 2. Scope

**In scope**
1. **2a — the report UI.** Surface the `CorrelationReport` as an explicit pre-rewrite step folded
   into the existing tailor page: two separate signals (never a fused %), status-grouped
   requirement rows with verbatim evidence, and a single "rewrite" action.
2. **2d — the ATS before→after delta.** Recompute the literal ATS check on the accepted merge at
   finalize, persist it on `TailoredResume`, and render it as the deterministic proof.

**Out of scope (own specs / later)**
- **2b** eligibility/knockout + legitimacy pre-gates — separate spec.
- **2c** embeddings / LLM-judge fit scoring — deferred per design §2.
- Per-row / select-rows selective rewrite (needs contract work; see §11).
- Self-extraction of `jdFacts` for never-scored jobs (keep the `409` funnel; design §7).
- Live "ATS-as-you-toggle" preview before finalize.
- A skip-report one-shot path (the report is always shown — it is the product thesis).

## 3. Locked decisions (from the Phase 2 brainstorm)

1. **Placement:** fold the report inline into the existing `/jobs/[id]/tailor` state machine — one
   page, one route, one continuous motion. No separate report route.
2. **Report layout ("A"):** two labelled signals with a segmented composition bar; requirement
   rows grouped by **status**, ordered **Buried → Met → Gap** (rewrite targets on top).
3. **Rewrite trigger:** a single **"Rewrite to close these"** action rewrites all `buried`+`met`
   candidates at once (matches today's API). Granular control remains downstream via the existing
   per-edit accept/reject in diff review.
4. **Never-scored jobs:** keep the `409` ("score this job first"). The tailor entry shows a
   `needs-score` affordance. No inline `jdFacts` self-extraction.
5. **ATS delta home:** a field on `TailoredResume`, computed at finalize on the accepted merge.

## 4. Flow & state machine

The page (`src/app/(app)/jobs/[id]/tailor/page.tsx`) keeps owning the state machine; the composition
stays presentational. `TailorUiState` grows to:

```
configuring → correlating → report → rewriting → review → saved | exporting
             ↘ needs-score (correlate 409)          ↘ error (any failure)
```

- **configuring** — `TailorControls`; CTA relabelled **"Analyze fit"** → `POST /api/tailor/correlate {jobId}`.
- **correlating** — skeleton; **poll** `GET /api/tailor/correlate/:id` until terminal (mirrors the
  existing `getTailor` 400 ms poll). SSE stage labels (`extract → classify → verify`) are available
  but not required for MVP.
- **report** — new `TailorReport` view (layout A). CTA **"Rewrite to close these"** →
  `POST /api/tailor {jobId, reportId}` (existing route; `reportId` is pre-validated → `404` on
  unknown).
- **rewriting → review** — existing `pollUntilTerminal(getTailor)`, then existing `ChangeList` +
  `TailorPreview` + `ExportBar`, unchanged except each diff row shows its `requirement`.
- **needs-score** — correlate returned `409 CONFLICT`; show "Score this job first" + a CTA to the
  scoring flow.

The old one-shot "Generate" is retired **from the UI**; the backend auto-correlate (`reportId`
omitted) stays for API robustness but the UI always routes through the report.

## 5. Report UI (2a)

### 5.1 New composition — `src/caliber-ui/compositions/Tailor/TailorReport.tsx`
Presentational, fully controlled (mirrors `TailorResume`'s prop-callback pattern). Props:

```ts
interface TailorReportProps {
  report: CorrelationReport;
  rewriting: boolean;       // disables the CTA + shows progress
  onRewrite(): void;
}
```

- **Two-signal header** (never fused):
  - **Requirements covered** — a local segmented bar (`met` / `buried` / `gap` widths) + readout
    "`{met+buried}` of `{total}` · `{met}` met · `{buried}` buried · `{gap}` gap".
  - **ATS keywords present** — reuse the **`FitBar`** primitive with `display="{present} of {total}"`
    (tone by ratio), plus a **`Chip`** row for `ats.missing`.
- **Status-grouped rows** (Buried → Met → Gap), each row:
  - status pill via the **`Tag`** primitive: `met → good` (carries a check), `buried → warn`,
    `gap → neutral`;
  - `requirement` text + `kind` label + a small ATS ✓/✗ marker (`atsPresent`);
  - verbatim `evidence` quote (present iff `met`/`buried`) — the audit trail;
  - `reason`, and for `gap` rows the optional `note` ("supportable via …").
- **Empty/degenerate states:** all-met (no buried group, CTA still rewrites met rows to reinforce
  ATS terms), all-gap (CTA disabled with "nothing to honestly surface yet"), empty `ats.missing`
  (hide the chip row).

### 5.2 Local segmented bar
The `met/buried/gap` composition bar is the only genuinely new visual. It is a **local**
sub-component inside `compositions/Tailor/` (e.g. `SignalBar.tsx`), composing `tokens.css`
variables — **not** a 14th global primitive. `FitBar` is single-fill and does not segment, so it is
reused for the ATS signal only.

### 5.3 Diff-review addition
`src/caliber-ui/compositions/Tailor/ChangeList.tsx` gains a small change: render each edit's
`requirement` (already on every `diff[]` entry) as a label so accepted/rejected edits trace back to
their report row. Section grouping is otherwise unchanged.

## 6. ATS before→after delta (2d)

### 6.1 Contract
Add to `TailoredResume` (`src/types/index.ts`, mirrored into `docs/architecture/api-contract.md`):

```ts
atsDelta: z.object({
  before: z.number().int(),   // present count on the base résumé  = linked report's ats.present, snapshotted at finalize
  after:  z.number().int(),   // present count on the accepted merge, same term set + normalization
  total:  z.number().int(),   // = report's ats.total
}).nullable(),                // null until finalized; null for legacy rows / rows with null reportId
```

### 6.2 Finalize recompute (`src/server/tailor/index.ts`, `finalizeTailor`)
`finalizeTailor` already computes `applyAcceptedDiff(base.structured, row.diff, acceptedIndices)`
(currently discarded). Capture that `merged` result and:
1. Load the linked `CorrelationReport` (`row.reportId`); if null (legacy), leave `atsDelta` null.
2. `after` = count of report `term`s that occur in the **merged** résumé, measured **identically**
   to the report's `atsPresent`: flatten the merged résumé to searchable text with the same routine
   `correlate` uses to build its résumé text, then apply the same `matches` normalization from
   `correlate-metrics.ts`. Factor a small pure helper `atsPresentCount(terms, resumeText)` there and
   reuse it; do not duplicate the normalization or the flattening (any divergence makes before/after
   non-comparable and voids the "stable proof" property).
3. `before` = report's `ats.present`; `total` = report's `ats.total`.
4. Persist via `tailoredResumesRepo.finalize(id, { acceptedIndices, finalizedAt, atsDelta })`.

Because `after` depends on which edits were accepted, the delta honestly reflects what the user
kept. It is computed on both save and export (both call `finalizeTailor`).

### 6.3 Render
`TailorResume`'s `saved` state renders `tailored.atsDelta` as "ATS keywords `{before} → {after}`
(of `{total}`)". No live preview while toggling (out of scope §2).

## 7. Data model & contract deltas (summary)

- **`TailoredResume`** — add `atsDelta` (§6.1). No other schema changes; `reportId`, `diff.requirement`,
  `diff.target` already shipped in Phase 1.
- **Persistence** — new Drizzle migration: nullable `ats_delta` jsonb column on `tailored_resumes`.
- **Repo** — `tailoredResumesRepo.finalize` accepts and writes `atsDelta`.
- **Client (`src/features/tailor/client.ts`)** — add `startCorrelate(jobId): Promise<CorrelationReport>`
  and `getCorrelate(id): Promise<CorrelationReport>` (mirror `startTailor`/`getTailor`).
- **No new API routes** — `POST /api/tailor/correlate`, `GET /api/tailor/correlate/:id`, and
  `POST /api/tailor {jobId, reportId}` all shipped in Phase 1.

## 8. Error handling (fail-loud)

- correlate `409 CONFLICT` (no `jdFacts`) → `needs-score` state (deliberate funnel; §3.4).
- correlate `404` (unknown job) / any correlate failure → `error`.
- rewrite failure → `error` (existing).
- The report renders exactly the persisted rows — no defaulted or fabricated values; a null/absent
  report is an error, not an empty render.
- `atsDelta` is null only for legacy/`reportId`-null rows; for a report-driven finalize it is always
  computed.

## 9. Files touched

**New**
- `src/caliber-ui/compositions/Tailor/TailorReport.tsx` (+ `.stories.tsx`, + DOM test).
- `src/caliber-ui/compositions/Tailor/SignalBar.tsx` — local segmented met/buried/gap bar.
- Drizzle migration — `tailored_resumes.ats_delta` jsonb.

**Changed**
- `src/app/(app)/jobs/[id]/tailor/page.tsx` — expanded state machine, correlate poll, 409 handling.
- `src/caliber-ui/compositions/Tailor/TailorResume.tsx` — new `correlating`/`report`/`rewriting`/
  `needs-score` states; render `atsDelta` in `saved`; wire `TailorReport`.
- `src/caliber-ui/compositions/Tailor/TailorControls.tsx` — "Analyze fit" CTA.
- `src/caliber-ui/compositions/Tailor/ChangeList.tsx` — per-edit `requirement` label.
- `src/features/tailor/client.ts` — `startCorrelate` / `getCorrelate`.
- `src/types/index.ts` + `docs/architecture/api-contract.md` — `atsDelta`.
- `src/server/tailor/index.ts` — `finalizeTailor` ATS recompute.
- `src/server/tailor/correlate-metrics.ts` — `atsPresentCount(terms, resumeText)` helper.
- `src/server/persistence/schema.ts` + `src/server/persistence/repos/tailoredResumes.ts` — column +
  `finalize` write.
- `docs/architecture/component-inventory.md` — `TailorReport` entry.

## 10. Testing strategy

- **Component (Storybook + DOM tests):** `TailorReport` across met/buried/gap mixes, all-met,
  all-gap, empty `missing`; `SignalBar` widths; `ChangeList` requirement label.
- **Page state machine:** `configuring → correlating → report → rewriting → review`, and
  `correlate 409 → needs-score`.
- **Finalize (default `npm test`):** unit-test `atsPresentCount` and the before→after computation
  (accepted-subset changes `after`); route test asserts `atsDelta` shape and that it reflects
  accepted indices.
- **e2e (`e2e/tailor.spec.ts`):** extend to the report step, the rewrite CTA, per-edit accept, and
  the ATS-delta readout in the saved state.

## 11. Open follow-ups (not this spec)

- **Selective rewrite** (per-row or select-rows-then-rewrite) — needs the `POST /api/tailor` route to
  accept a requirement subset and the rewrite/merge to be partial-report-aware.
- **Live ATS preview** while toggling edits — needs a client-side recompute or a dry-run endpoint.
- **Eligibility/legitimacy pre-gates (2b)** — own brainstorm → spec.
- Phase 1 hardening backlog (handoff §3) remains independently tracked.
