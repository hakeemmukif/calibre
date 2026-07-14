# Multi-Tenant Read Scoping + Route Auth (Step 3 of 9)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.
> **Revised 2026-07-14 after a Fable design review** — incorporates: url_checks read+worker leak, by-uuid PATCH leaks, cursor-subquery existence oracle, profile-upsert conflict target, ordering fixes, second-user fixtures, and a mechanical scoping-audit gate. Fable's cross-cutting finding: "no unscoped query survives" is only as good as the enumeration — so Task 6 adds a *mechanical* gate, not just a checklist.

**Goal:** Make multi-user isolation actually true. Every repo READ gains a required `userId` and filters by it (non-owner → null → 404, no existence leak). Every route calls `requireUser()` and threads `session.userId` — replacing Step 2's `BOOTSTRAP_ADMIN_ID` scaffolds. Async/worker paths derive `userId` from the owning DB row. SSE routes verify run ownership before subscribing. `PUT /api/profile` becomes a per-user upsert so fresh registrants can onboard. Cross-user isolation is proven by second-user unit tests + a live two-user HTTP smoke + a mechanical audit gate.

**Architecture:** Row-level scoping in the repo layer via a required `userId` first parameter on every read (mirrors Step 2's write pass). Route handlers resolve the caller once via `requireUser()` and pass `session.userId` down; background/worker code (no session) derives `userId` from the owning row (`search_runs.user_id`, the claimed `url_checks.user_id`, the scored `job.user_id`). Admin full-content access (decision #7) is deferred but enabled: admin routes will pass a **target** userId into these same scoped repos.

**Tech Stack:** Next.js 15 · TypeScript · Zod · Drizzle + Postgres (PGlite in tests). Builds on Step 1 (auth) + Step 2 (`user_id` columns, write scoping).

## Global Constraints
- **Every read takes a required `userId` and filters `WHERE user_id = userId`** — including reads that key on a uuid PK (`getById(id, userId)` adds `eq(t.userId, userId)`), so a guessed/stolen foreign id returns null → 404, never a 403 that leaks existence. No default, no ambient context.
- **Every route handler calls `requireUser()` first** (→ 401) and threads `session.userId`, replacing Step-2 scaffolds. Unauthenticated by design: `/api/health`, `/api/auth/*`. **`/api/docs` is a deliberate decision — default: leave public** (it serves the contract page; revisit if it should be gated).
- **Async/worker paths derive `userId` from the owning row, never a session and never a fallback to admin.** `job_scores.userId` comes from `job.userId` (the row being scored), structurally not a threaded param.
- **Scaffold-during-transition is allowed the same way Step 2 did it:** a call site whose route-level `requireUser()` lands in a later task may temporarily pass `BOOTSTRAP_ADMIN_ID` as a *read* userId to stay green — but Task 6's grep gate drives every such literal in non-test `src` to zero.
- **Fail loud.** Missing profile still throws `ProfileMissingError` (now per-user). No runtime default of `userId`.
- **No existence leaks.** Foreign-owned resource → 404, identical to nonexistent.
- **Daily LLM cost cap stays GLOBAL** (`job_scores.costUsd` summed across users) — do NOT scope it. **`sources` reads stay global** (admin-managed). `searchRuns.markAllUnfinishedAsFailed` and the worker's claim/sweep/attempt-fenced writes stay global (infra). Each such exception carries an explicit `// GLOBAL-BY-DECISION: <reason>` comment (Task 6 audits for this).
- **Suite stays green at each task.** Baseline: 826. Contract: register `UNAUTHORIZED` (401) on guarded routes; `contract:check` stays green.

## The read-scoping transformation (uniform, mirrors Step 2's write pass)
Each read method: gains `userId: string` first param; adds `eq(t.userId, userId)` to its `WHERE`; singleton + call sites + tests thread a `userId`. **Cursor subqueries must also carry the userId filter** (see Task 3). Do not re-scope Step-2 write inserts, but DO scope route-reachable by-uuid UPDATEs the write pass didn't cover (Task 3/4).

---

## Task 1: profile per-user + onboarding upsert (unblocks registrants)
**Files:** `repos/profile.ts` (+test), `app/api/profile/route.ts` (+test), `profileRepo` call sites (`server/search/run.ts`, `server/url-check/worker.ts`, `server/search/jobsFeed.ts`, eligibility resolver).
**Why first:** every scan/score/feed path reads the profile, and today there is NO create path (`get`/`update` both throw `ProfileMissingError`; only `seed.ts` inserts) — a fresh registrant can never onboard.
- [ ] Drop `SINGLETON_ID`. `get(userId)` filters `user_id = userId` (throws `ProfileMissingError` if absent). `update(userId, input)` scoped.
- [ ] Add `upsert(userId, input)` — **conflict target `profile.userId`** (NOT `profile.id`): the schema's `profile_user_id_unique` (schema.ts:96) is the arbiter, and the seeded admin already has `id="default", userId=admin`, so targeting `id` would raise a unique violation on `user_id` on the admin's first PUT. `id` value is then cosmetic (use a fresh uuid).
- [ ] `PUT /api/profile`: `requireUser()` → `upsert(session.userId, body)` → 200 (this is the onboarding path). `GET /api/profile`: `requireUser()` → `get(session.userId)` → 404 on `ProfileMissingError`, 401 on no session. Register both 401 and 404 in the contract.
- [ ] Call sites: route/synchronous callers pass `session.userId`; the worker passes `row.userId`; feed passes the caller's userId. (Temporary `BOOTSTRAP_ADMIN_ID` read-scaffold permitted where the route task lands later.)
- [ ] Tests (second-user fixture): two users' profiles independent; PUT creates then updates; admin's first PUT upserts cleanly (no unique violation); GET 401/404. Commit.

## Task 2: resumes read scoping
**Files:** `repos/resumes.ts` (+test), `app/api/resume/route.ts` (+test), callers.
- [ ] `getActive(userId)` → `WHERE is_active AND user_id = userId`. `getById(id, userId)` → add userId filter.
- [ ] `GET /api/resume`: `requireUser()` → `getActive(session.userId)`. `POST /api/resume`: thread `session.userId` (replace ingest scaffold).
- [ ] Callers (`server/url-check/worker.ts:90`, scan admission, tailor) thread the owner's userId — **worker uses `row.userId`**, not a session, not admin.
- [ ] Tests (second user): A's active résumé invisible to B; GET 401/404. Commit.

## Task 3: jobs + feed read scoping (incl. cursor oracle + getLatestCompleted)
**Files:** `repos/jobs.ts` (+test), `repos/searchRuns.ts` (getLatestCompleted only), `server/search/jobsFeed.ts`, `app/api/jobs/route.ts`, `jobs/[id]/route.ts`, `jobs/[id]/evaluate/route.ts` (+tests).
- [ ] Add `userId` to `JobsQuery`; push `eq(jobs.userId, userId)` in `buildFilterConditions` (scopes `listScored`/`statsForQuery`/`countHiddenByEligibility`). **Also add `AND user_id = userId` INSIDE the cursor subquery (jobs.ts:142)** — otherwise a cursor encoding a foreign job id is an existence oracle. `getByDedupeKey(dedupeKey, userId)`, `getById(id,userId)`, `getRowWithSourceById(id,userId)`, `existsById(id,userId)`, `hasAnyScore(jobId,userId)` add the filter. `updateDescription(id,userId,...)` / `updateEligibility(id,userId,...)` (by-uuid writes) add `userId` to their WHERE.
- [ ] `searchRuns.getLatestCompleted(userId)` scoped **here** (Task 3 depends on it for `sinceLast`).
- [ ] `latestJobScores` DISTINCT-ON subquery stays global (it inner-joins back to scoped `jobs` rows → leak-free; perf-only). `jobScoresRepo.getLatestByJobId` stays by-jobId with a `// GLOBAL-BY-DECISION: caller verifies job ownership first` comment (allowlisted).
- [ ] `listJobsFeed(query, userId)`; `GET /api/jobs`: `requireUser()` → pass `session.userId`. `GET/DELETE /api/jobs/[id]`, `POST .../evaluate`: `requireUser()` + scoped.
- [ ] Tests (second user): A's feed excludes B's jobs; `GET /api/jobs/{B id}` → 404; **cursor encoding B's id behaves identically to an unknown uuid** (oracle test); same-URL paste by A and B does not collide, each sees only their own. Commit.

## Task 4: runs / tailor / applications / answers — reads + by-uuid PATCH + SSE ownership + per-user mutex
**Files:** those repos (+tests); `server/runs/registry.ts`; routes `search/[id]`, `tailor/[id]`(+`/pdf`,`/finalize`), `applications`+`[id]`, `apply/answers`+`[id]`, `apply/questions` (+tests).
- [ ] Reads gain `userId`+filter: `searchRuns.getById(id,userId)`; `tailoredResumes.getById(id,userId)`; `applications.list(userId)`/`getById(id,userId)` (+ cursor subquery at applications.ts:91 scoped like jobs); `applicationAnswers.getById(id,userId)`.
- [ ] **By-uuid PATCH leaks (Fable):** `applicationsRepo.patch(id,userId,...)` and `applicationAnswersRepo.update(id,userId,answers)` add `userId` to their WHERE — else B can `PATCH /api/applications/{A id}` / `/api/apply/answers/{A id}`. `tailoredResumes.finalize` is gated by the scoped `getById` in `finalizeTailor` — note it, no change needed.
- [ ] **SSE ownership:** `GET /api/search/[id]` and `GET /api/tailor/[id]`: after `requireUser()`, fetch the row via `getById(id, session.userId)`; not found → 404 **before** subscribing to the run handle. (EventSource can't send headers → cookie session is the auth.) `RunHandle` needs no owner field.
- [ ] **Per-user mutex:** `server/runs/registry.ts` — key `activeRunByPersona` as `${userId}:${persona}`; `create`/`getActiveRunForPersona`/`release` take `userId`. `POST /api/search` 409 becomes per-user. Thread `userId` through `server/search/run.ts`, `server/tailor/index.ts`, `server/apply-assistant/answer.ts`, `server/tracker/index.ts`, `server/score/index.ts` (replace Step-2 scaffolds; `scoreJob` sets `job_scores.userId = job.userId`).
- [ ] Tests (second user): A cannot SSE/poll/PDF B's run (404); A cannot PATCH B's application or answers (404, row unchanged); A's tracker/applications exclude B's; 409 mutex is per-user (A's active run doesn't block B). Commit.

## Task 5: url_checks tenancy — reads + worker claim-time re-check  ⚠️ DECISION-GATED
**Files:** `repos/urlChecks.ts` (reads), `server/url-check/worker.ts`, `server/url-check/run.ts` (getUrlCheck/listActiveChecks/listChecksByIds), routes `jobs/check`, `jobs/check/[id]` (+tests).
> ⚠️ This touches the surface locked-decision #1 said to avoid (to limit merge conflict with `feat/parallel-scoring`). But the worker + its read routes are on `main` now (pasted-job-ingestion merge, 2026-07-13) and DO leak cross-tenant. **Operator must confirm: scope it now (fix the leak, accept a larger later merge conflict) or defer.** If deferred, the app ships a real cross-tenant leak — not acceptable for multi-tenant. Recommended: scope it.
- [ ] Reads: `urlChecks.getById(id,userId)`, `listActive(userId)`, `listByIds(ids,userId)` add the filter → `getUrlCheck`/`listActiveChecks`/`listChecksByIds` thread it; routes `requireUser()` + `session.userId`.
- [ ] **Worker claim-time re-check (worker.ts:84-95):** `getByDedupeKey(row.dedupeKey, row.userId)`, `hasAnyScore(existingJob.id, row.userId)`, `getActive` → `getActive(row.userId)`, `profileRepo.get(row.userId)`. Else B's queued check for A's URL completes `alreadyKnown` pointing at A's jobId (leak + B's UI 404s). Worker claim/sweep/attempt-fenced writes stay global (`// GLOBAL-BY-DECISION`).
- [ ] Tests: B polls A's check id → 404; `?active=1` returns only B's; **worker cross-tenant dedupe**: A owns scored job for URL X, B enqueues X, `drainOnce()` gives B their OWN job row (not A's). Commit.

## Task 6: full green + mechanical scoping-audit gate
**Files:** sweep `app/api/**/route.ts`; `src/contract/registry.ts`; a new `scoping-audit.test.ts` (or a `check` script).
- [ ] Guard every remaining handler with `requireUser()` (except health/auth; `/api/docs` deliberately public). Register `UNAUTHORIZED` for guarded routes; `contract:check` 0.
- [ ] **Mechanical gate (Fable's de-risk):** a test that scans every repo read method's `.where(` and fails if it lacks a `userId` term UNLESS the method carries an explicit `// GLOBAL-BY-DECISION:` comment (allowlist: `sources` reads, cost-cap sum, `markAllUnfinishedAsFailed`, worker claim/sweep/attempt-fenced writes, `getLatestByJobId`). Converts "we think we got them all" into a failing check when Steps 5-9 add the next read.
- [ ] Assert ZERO `BOOTSTRAP_ADMIN_ID` in non-test `src` except `seed.ts`/`ids.ts`.
- [ ] Full suite green (826 + isolation tests), typecheck, `contract:check` 0, `npm run build`.

## Task 7: live two-user isolation acceptance (throwaway Postgres + real server)
- [ ] Migrate+seed a throwaway DB; start the server; register A and B; each uploads a résumé + pastes a job URL; assert via HTTP: A's `GET /api/resume` and `/api/jobs` never show B's; A's `GET /api/jobs/{B id}` → 404; A's `GET /api/search/{B run}` → 404; A polling B's url-check → 404; same URL by both does not collide. Drop the DB. Step-3 acceptance gate.

## Self-Review
- Every read scoped (incl. cursor subqueries, by-uuid gets); ownership-by-construction. ✓ (Tasks 1–5)
- By-uuid PATCH mutations scoped (applications, answers). ✓ (Task 4)
- url_checks reads + worker re-check scoped (⚠️ decision-gated). ✓ (Task 5)
- Every route `requireUser()`; scaffolds → `session.userId`; async → `row.userId`; zero admin fallback. ✓ (Tasks 1–6)
- SSE ownership; per-user 409 mutex (registry keyed userId:persona); feed stats/sinceLast per-user. ✓ (Tasks 3–4)
- Onboarding unblocked (profile upsert, correct conflict target). ✓ (Task 1)
- Second-user fixtures + mechanical audit gate + live two-user smoke. ✓ (Tasks 1–7)
- **Deferred:** admin content routes/page (Step 6/7); frontend route groups/AppShell/onboarding UI (Step 4); résumé file re-root (Step 5); global cost cap stays global.
