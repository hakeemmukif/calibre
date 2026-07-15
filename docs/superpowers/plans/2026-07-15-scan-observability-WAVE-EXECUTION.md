# Scan Observability — Wave Execution Schedule (M1 → M2)

Subagent-driven development, parallelized into **waves**. Every task within a wave is **file-disjoint** and **dependency-independent** from its wavemates, so the wave's implementers run concurrently in **isolated git worktrees** and merge cleanly. Between waves the controller merges the wave's branches into the integration branch (in listed order), so wave N+1 branches from N's merged state.

**Integration branch:** `feat/scan-observability` (off `main`, which already has M0). All work merges here; final merge to `main` via `superpowers:finishing-a-development-branch`.

## Rules that make the waves safe

- **Isolation:** each implementer runs with `isolation: "worktree"`, branched from the current integration HEAD.
- **Disjoint files only:** two tasks share a wave **only** if their file-touch sets don't intersect. Verified per wave below.
- **Merge between waves:** controller merges each finished+reviewed task branch into `feat/scan-observability` before dispatching the next wave. Conflict-free by construction.
- **Per-task review still applies:** after a wave's implementers report DONE, dispatch the task reviewers **in parallel** (one per task, diff-scoped), run fix loops, THEN merge the wave.
- **Deferred green gate:** M1-Task 1 intentionally leaves a typecheck break that M1-Task 4 closes (`toSearchRun` under-supplies stats until then). So the *full* `npm run check` is not expected to pass mid-spine — each task runs only its **own** tests (TDD). The whole-branch gate is the final task of each milestone.
- **Model/effort:** taken from each plan's task-assignment table; `high` → `deep-thinker` (fable), else `executor` (sonnet). Passed explicitly on every dispatch.

---

## M1 — 5 waves (11 tasks). Max parallel width: 3.

Task 6 is **split** because its two halves have different dependencies:
- **T6a** = add `listScans` + `getScanDetail` readers (needs only T1).
- **T6b** = retire `getSearchRun` + repoint `spine.test` (needs T5's route-shape change first, else `spine.test` fails in isolation).

| Task | Files (disjoint within wave) | Depends on |
|------|------------------------------|------------|
| T1 Types | `types/index.ts` (+test) | — |
| T2 Migration+label | `schema.ts`, `drizzle/*`, résumé write-path | T1 |
| T3 Repo | `repos/searchRuns.ts` (+test) | T2, T1 |
| T4 run.ts wiring | `search/run.ts`, `search/assemble-run.ts` (+test) | T3, T2, T1 |
| T5 API | `api/search/route.ts`, `api/search/[id]/route.ts`, `assemble-summary.ts` (+tests) | T3, T1 |
| T6a Client readers | `features/search/client.ts` (+test) | T1 |
| T6b Retire getSearchRun | `features/search/client.ts`, `app/spine.test.ts` | T5, T6a |
| T7 Nav | `AppSidebar.tsx`, `AppShell.tsx` (+test) | — |
| T8 List page | `app/(app)/scans/page.tsx`, `Scans/ScansList.tsx` (+test) | T6a, T1 |
| T9 Detail page | `app/(app)/scans/[id]/page.tsx`, `Scans/ScanReplay.tsx` (+test) | T6a, T1 |
| T10 Retire overlay | `feed/page.tsx`, `resume/page.tsx`, delete `scanHandoff*` | T8, T9 |
| T11 Gate+docs | `docs/architecture/*` + full `npm run check` | all |

### Waves

- **Wave M1.1 — `{ T1, T7 }`** (2 agents)
  Disjoint: `types/index.ts` vs `AppSidebar/AppShell`. Both dependency-free.
  Models: T1 sonnet/med, T7 sonnet/low.

- **Wave M1.2 — `{ T2, T6a }`** (2 agents)
  Disjoint: `schema.ts`+`drizzle`+résumé-route vs `client.ts`. Both need only T1 (merged).
  Models: T2 sonnet/med, T6a sonnet/low.

- **Wave M1.3 — `{ T3, T8, T9 }`** (3 agents)
  Disjoint: `repos/searchRuns.ts` vs `scans/page.tsx`+`ScansList` vs `scans/[id]/page.tsx`+`ScanReplay`. T3 needs T2; T8/T9 need T6a (both merged). T8/T9 dom-test against a mocked client, so they don't need the API (T5) yet.
  Models: T3 fable/high, T8 sonnet/med, T9 sonnet/med.

- **Wave M1.4 — `{ T4, T5, T10 }`** (3 agents)
  Disjoint: `run.ts`+`assemble-run.ts` vs `api/*`+`assemble-summary.ts` vs `feed/page.tsx`+`resume/page.tsx`. T4/T5 need T3; T10 needs T8/T9 (all merged). B3's `client.ts` edit is NOT here — it's T6b.
  Models: T4 fable/high, T5 sonnet/med, T10 fable/high.

- **Wave M1.5 — `{ T6b, T11 }`** (sequential inside the wave: T6b then T11)
  T6b retires `getSearchRun` (now that T5's route shape is merged) + repoints `spine.test`; then T11 regenerates contract/inventory docs and runs the **full `npm run check`** — the first point the whole spine is expected green. Not parallel (T11 gates on T6b).
  Models: T6b sonnet/low, T11 sonnet/low.

**Critical-path length:** T1 → T2 → T3 → T4 → (T11) ≈ 5 stages vs 11 sequential. ~2× wall-clock at width 3.

---

## M2 — 5 waves (8 tasks). Max parallel width: 3. **Starts only after M1 is merged.**

`registry.ts` is touched by both T1 (`RunEvent`) and T2 (`RunHandle`) → they must not share a wave.

| Task | Files (disjoint within wave) | Depends on |
|------|------------------------------|------------|
| T1 Event vocab | `types/index.ts`, `registry.ts`, `client.ts` (+test) | — (M1 merged) |
| T2 Frame slot | `registry.ts` (+test) | T1 |
| T3 Emit deltas | `search/run.ts`, `score/index.ts` (+test) | T1, T2 |
| T4 Snapshot | `api/search/[id]/route.ts` (+test) | T1, T2 |
| T5 Reducer+hook | `scanLive.ts`, `useScanLive.ts` (new) (+test) | T1 |
| T6 Compositions | `SourceStrip.tsx`, `ScanLanes.tsx` (new) (+test) | T5 |
| T7 Wire page | `scans/[id]/page.tsx` | T5, T6 |
| T8 Gate+docs | `docs/architecture/*` + full `npm run check` | all |

### Waves

- **Wave M2.1 — `{ T1 }`** (1 agent) — sonnet/med. Alone: it holds `registry.ts` + `types/index.ts` + `client.ts`; everything else imports its types.
- **Wave M2.2 — `{ T2, T5 }`** (2 agents) — disjoint: `registry.ts` vs new `scanLive/useScanLive`. Both need T1. T2 sonnet/med, T5 fable/high.
- **Wave M2.3 — `{ T3, T4, T6 }`** (3 agents) — disjoint: `run.ts`+`score` vs `[id]/route.ts` vs new compositions. T3/T4 need T2; T6 needs T5 (all merged). T3 fable/high, T4 fable/high, T6 sonnet/med.
- **Wave M2.4 — `{ T7 }`** (1 agent) — sonnet/med. Wires lanes into the running `/scans/:id`.
- **Wave M2.5 — `{ T8 }`** (1 agent) — sonnet/low. Contract/inventory regen + full `npm run check` (M0+M1+M2).

**Critical-path length:** T1 → T2 → T3 → T7 → T8 ≈ 5 stages vs 8 sequential.

---

## Per-wave controller loop

For each wave:
1. **Dispatch implementers in parallel** — one `Agent` per task, `isolation: "worktree"`, model/effort per the tables, each handed its `task-brief` file path + report-file path + the interfaces it consumes from already-merged tasks. No pasted history.
2. **Collect statuses.** Handle DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED per the skill.
3. **Dispatch task reviewers in parallel** — one per task, each with its `review-package` (BASE = integration HEAD at dispatch), brief, report, and the verbatim Global Constraints.
4. **Fix loops** for Critical/Important findings (one fix subagent per task with findings), re-review.
5. **Merge** each reviewed-clean branch into `feat/scan-observability` in table order. Resolve the (by-design rare) merge — should be none.
6. **Ledger:** append `Wave M1.x: Tn complete (commits …, review clean)` to `.superpowers/sdd/progress.md`.
7. Next wave branches from the new integration HEAD.

Final: whole-branch review on the most capable model, then `superpowers:finishing-a-development-branch`.

## Honest caveats

- **The spine dominates.** T1→T2→T3→T4 (M1) and T1→T2→T3 (M2) are hard serial chains — types before schema before repo before engine. Parallel width tops out at 3, and only in the middle/back waves. This is ~2× faster, not N×.
- **Intermediate waves don't fully typecheck.** By design (T1's deferred break). Task-scoped tests are the gate until the milestone's final task. Don't run `npm run check` as a per-wave gate — it will red until T11 / M2-T8.
- **Worktree cost is real** (~200–500ms + disk each). Justified here because wavemates mutate files concurrently; a wave of 1 doesn't need isolation (M2.1/M2.4/M2.5 can run in-place).
