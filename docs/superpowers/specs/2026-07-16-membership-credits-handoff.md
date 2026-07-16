# Membership, Credits & Guardrails — implementation handoff

**Date:** 2026-07-16
**Status:** handoff — planning is COMPLETE; the next session's job is execution, not design.
**Design spec:** `docs/superpowers/specs/2026-07-16-membership-credits-guardrails-design.md` (operator-approved, committed @753d371; §2 decisions are locked — do not re-litigate).
**Implementation plan:** `docs/superpowers/plans/2026-07-16-membership-credits-guardrails.md` (11 TDD tasks with exact files/code/tests/commits — the execution authority; read it before anything else).
**Visual preview:** claude.ai/code artifact "Caliber — Membership & Credits Preview" (credits-preview-v1) — operator reviewed and approved 2026-07-16 ("looks good").

## 1. Where things stand

- The design spec, the implementation plan, and the visual preview are all done and operator-approved. **No implementation code exists.**
- `main` @753d371 is pushed and in sync with origin. The perf/scan-overhead work (7 commits: rescan skip-gate, session-write throttle, registry eviction, indexes/migration 0001) is merged and live on main — the plan builds on it (e.g. the sessions repo already has the 5-minute `lastUsedAt` bump throttle that Task 1's TTL check sits next to).
- Dev DB (`caliber.db`) has migration 0001 applied. Production VPS (caliber.fightbase.co) is still running pre-perf code with a placeholder `OPENROUTER_API_KEY` — deploying this feature later requires the push-to-box flow (`/box` skill) plus setting `CALIBER_INVITE_CODE` on the box.

## 2. How to execute

- Branch `feat/membership-credits` from `main`. Execute the plan task-by-task with **superpowers:subagent-driven-development** — per operator directive, Sonnet `executor` subagents build from the plan's briefs; the orchestrating session reviews every diff inline, runs the gates, and commits per task.
- Task order = plan order (= spec §6 rollout). Tasks 6 and 7 (entry-point enforcement) are parallel-safe once 4–5 land; everything else is sequential. Tasks 1–2 ship value standalone.
- Gates: scoped `npx vitest run <paths>` per task; `npm run check` (typecheck + full suite + contract check + build) before merge. The commit hook runs `tsc` from the session cwd — keep every commit green.

## 3. Locked decisions beyond the spec (made during planning — do not re-open)

**Operator UX pivot (2026-07-16, resolves the bundle-math conflict):** résumé upload NO LONGER auto-starts scans. The dual-persona `Promise.allSettled` kickoff in `src/app/(app)/resume/page.tsx` is removed (it would have burned 23 credits on arrival). New flow: upload → kit's `parsing` state with duration-honest copy → résumé review → explicit prompt → user starts ONE scan (persona choice, 10 credits) → `/scans/{run.id}`. ScansList rows gain a persona `Tag`. Plan Task 8; also requires updating `e2e/resume-scan-feed.spec.ts`, which assumes the auto-scan.

**Plan-locked engineering decisions (rationale in the plan, verified against code):**
1. `assertAndDebit(userId, feature, opts)` takes a **userId** and reads `plan`/`role` itself (spec sketched `AuthUser`, which doesn't carry `plan`); the fresh read makes admin plan-toggles live next request.
2. The atomic debit is a **single guarded `INSERT…SELECT…WHERE` statement** — never `db.transaction()` (see §4.1).
3. The tailor flow charges 8 **exactly once at a synchronous admission point** via a `prepaid` opt on `correlate()`: `startTailor` without a `reportId` runs correlate **inside the background job** (`src/server/tailor/index.ts:237`), where a 402 could never reach the user — so that path pre-checks jdFacts, debits at its own admission, and passes `{ prepaid: true }` down.
4. The signup grant is a **sequential insert guarded by the partial unique index** `credit_ledger_signup_once` (not a transaction); a crash between user-insert and grant leaves a visible zero-balance account the admin compensates — same compensation model as failed-run debits.
5. The url-check **worker is untouched**; debit at enqueue admission only, and the already-known short-circuit stays free.
6. Golden-path-26 is pinned piecewise at unit/route level plus a deterministic no-LLM 402 e2e — not a real-LLM e2e (that belongs in `smoke:real` if ever).

## 4. Hard-won constraints (violating these costs a day)

1. **NEVER `db.transaction()`** — @libsql/client's `file:` driver recreates its connection when an interactive transaction begins; concurrent transactions corrupt state. Proven twice on 2026-07-16 (SQLITE_BUSY storms / residual-row unique violations under the `pLimit(3)` scoring pool); `src/server/persistence/test-db.ts`'s header documents the mechanism. Production uses the same driver.
2. **Route tests' default auth mock is an admin** (`BOOTSTRAP_ADMIN_ID`, `role: "admin"`) — which **bypasses credits**. Every 402/debit test must mock a `role: "user"` session whose row exists in the test DB with `plan: 'standard'`.
3. **Migration numbering restarted at 0000** with the SQLite fresh-start; this feature's migration is `0002_*`. SQLite can't `ALTER TABLE … ADD COLUMN NOT NULL` without a DB-level `DEFAULT` on a non-empty table — hand-edit the generated migration (the drizzle schema keeps no default; inserts stay explicit per fail-loud policy). `createTestDb()` executes `drizzle/*.sql` directly, so tests pick migrations up automatically; do NOT run `db:migrate` against the dev DB mid-task (known env quirk: it doesn't load `.env` — pass `DATABASE_URL=file:./caliber.db` inline, and only at the end).
4. **`.env*` files are read-denied to agents** (including `.env.production.example`) — modify only via shell append (`printf/echo >>`), never Read/Edit. Dev needs `CALIBER_INVITE_CODE` appended to `.env` for local registration to keep working after Task 2; e2e sets it via `playwright.config.ts` webServer env + `e2e/authSetup.ts` payload.
5. **Contract-first discipline:** any `src/types` change → `npm run contract` and commit `contract/openapi.json` in the same commit (`contract:check` in the gate diffs it).
6. **Instrumentation boot check** (Task 2's production fail-loud for the invite code) goes inside `instrumentation.ts`'s `NEXT_RUNTIME === "nodejs"` block — it must not break `next dev` or the edge runtime pass.

## 5. Key file map (verified 2026-07-16)

- Users/sessions: `src/server/persistence/schema.ts` (~line 329/337), `repos/sessions.ts` (TTL goes before the bump-throttle), `repos/users.ts` (`create` ~28, `listWithCounts` ~71), `seed.ts` `seedAdmin` ~76.
- The 8 entry points and where the debit lands: table in plan Task 6/7 headers — `startSearch` (`src/server/search/run.ts`, after source validation, refId = pre-existing `runId`), `startUrlCheck` (`src/server/url-check/run.ts` ~308, queue path ~350, pregenerate the check id for refId), `evaluateJob` (`src/server/score/evaluate.ts:22`), `correlate` (`src/server/tailor/correlate.ts:152`), `startTailor` (`src/server/tailor/index.ts:114`, internal correlate call :237), `ingestResume` (`src/server/resume/ingest.ts:118`), `draftAnswers` (`src/server/apply-assistant/answer.ts:59`), `extractQuestions` free (`extract-questions.ts:54`).
- UI: `src/app/AppShell.tsx` (chip + dialog mount next to `<CheckDock />` ~line 72), `checksStore.ts` as the store idiom to mirror, `src/caliber-ui/components/Chip.tsx`/`Tag.tsx` for the chip/persona-tag looks, admin at `src/app/api/admin/users/route.ts` + `compositions/Admin/AdminUsersTable.tsx` (no PATCH route exists yet).
- Error wiring: `ErrorCode` at `src/types/index.ts:330` (add `RATE_LIMITED` in Task 2, `INSUFFICIENT_CREDITS` in Task 5); `ApiError` in `src/features/http.ts`; per-route local `errorResponse` idiom (no shared mapper — add the 402 branch per route).

## 6. Out of scope (do not build — spec §7 + standing backlog)

Stripe/any processor; subscriptions; credit expiry; monthly grants; per-user USD metering; Redis rate limiting; email verification; CAPTCHA; refund mechanics; purchase-history UI; per-invite-code DB rows. Separately parked (unrelated to this feature): connectors honoring `since` (biggest remaining perf win, needs its own spec), `appendResult` O(n²) → append-only table, applications `jobId` query param, remote-fit live verification, `eval:tailor` calibration, VPS `OPENROUTER_API_KEY`.

## 7. Definition of done

All 11 plan tasks committed on `feat/membership-credits`; `npm run check` green; e2e harness updated (invite-aware) with the deterministic 402 spec passing locally; DEPLOY.md tripwire section rewritten; merge decision back to the operator. Post-merge operator steps (not the implementer's): apply migration 0002 to the dev DB, set `CALIBER_INVITE_CODE` in `/opt/caliber/.env.production`, push-to-box deploy.
