# Pre-launch Hardening — consolidated plan

**Date:** 2026-07-16
**Status:** compiled from 7 parallel brainstorms + Fable review (needs-rework findings incorporated). **Pre-approval — the 3 forks in §Decisions are the operator's to settle before writing-plans produces executable TDD steps.**
**Scope:** everything that should exist before ~5-20 friends (invite-only, real résumés) touch caliber.fightbase.co. NOT public launch.
**Companion:** the membership/credits work (`docs/superpowers/specs/2026-07-16-membership-credits-handoff.md`) is a **hard prerequisite** — see §Sequencing. It closes the invite-gate / session-TTL / cost-cap tripwires; this plan is everything else.

## The launch gate

Before the first invite, ALL of these must be true:
1. **The credits work is deployed** (it's what invite-gates registration and bounds per-user spend — without it the box is open-registration + unmetered behind a live API key; DEPLOY.md:71-74's own tripwires).
2. **The paid LLM path is proven on the final deployment** (Task 1 — and the E2E leg must run *after* the last pre-invite deploy, not against today's pre-perf box).
3. **Backups exist off-box and a restore has been tested once** (Task 2).
4. **External down-detection reaches the operator's phone** (Task 3 blocker slice — uptime + push).

Everything else here is first-week.

---

## Global constraints (every code task)

- **NEVER `db.transaction()`** — libsql `file:` driver corrupts state under concurrency (proven twice, 2026-07-16). Atomicity = ordered single statements, idempotent re-runs. **Two live violations get fixed in this plan** (§Task 0) — one is the résumé-upload path every friend hits on launch evening.
- **Contract-first:** `src/types` change → `npm run contract` → commit `contract/openapi.json` same commit.
- **Fail loud:** `Schema.parse` at boundaries; no fallback defaults.
- **Kit canon:** compose the 13 primitives + `tokens.css`; legitimacy colour stays separate from the brand red.
- **`.env*` read-denied to agents** — shell-append only; box env edits are operator-only.
- **Layering:** UI → `features/*` → `server/*`.
- **Branch:** `feat/pre-launch-hardening` from `main` **after the credits work merges** (§Sequencing); per-task commits; every commit `tsc`-green.

---

## Decisions — SETTLED by the operator (2026-07-16)

1. **Support/feedback channel → Telegram, both surfaces** (crash page Task 4 + verdict-feedback Task 7). Operator chose Telegram over both WhatsApp and mailto. **Mechanic wrinkle (important):** Telegram does NOT support prefilled text to a *personal* account the way `wa.me?text=` does (removed capability). Use **`https://t.me/share/url?url=<postingUrl>&text=<encoded context>`** — prefills both fields; the user taps once to pick the operator from their chat list. (Alternative if that one-tap-to-pick is unacceptable: a dedicated feedback bot with a `?start=` deep-link param — more setup, routes straight to the operator. Default to the share-URL; revisit only if it feels clunky in testing.) Task 7's `feedback.ts` builds the `t.me/share/url` link; Task 4's crash copy links to the operator's Telegram (`https://t.me/<handle>`). Contact handle is the hardcoded constant / placeholder.
2. **Self-serve change-password → BUILD IT, first week.** Folded into Task 6: a `PATCH /api/auth/password` (current-password reverify) + a profile-page form, sharing `usersRepo.updatePasswordHash` + the session-kill with the reset script.
3. **Cost cap → raise `CALIBER_DAILY_LLM_USD` 5 → 10** for launch (operator chose 10, not 25). Reversible `.env.production` edit. Understand it only backstops runaway *scoring* (sums `job_scores` only; tailor/correlate/answers/url-check uncounted, and the `createdAt` clobber leaks even scoring spend) — the real per-user spend bound is the credits work.

*(Also resolved: R2 + age for backups; fix the transaction landmines in-plan; credits ships first.)*
*(Consistency follow-through: since the operator prefers Telegram, Task 3's alerting transport is Telegram too — see Task 3.)*

---

## Task 0 — Fix the two live `db.transaction()` landmines  ·  BLOCKER-adjacent  ·  ~45-60 min
Not one of the original 7, promoted by Fable. `src/server/persistence/repos/resumes.ts:16` (`insertReplacingActive`) is the **résumé-upload path — the first thing every invited friend does**, concurrently with `pLimit(3)` scoring writes: exactly the concurrency profile that proved the corruption. Rewrite as ordered single statements (deactivate active row, then insert; the partial unique index `resumes_user_id_active_unique` at schema.ts:127 makes a crash-between visible — same compensation model the credits plan accepts). Fix `src/server/jobs/delete-job.ts:60` in the same commit. Tests against `createTestDb`.

### Task 1 — Prod LLM smoke  ·  BLOCKER  ·  ~45 min (mostly box/browser)
Prove the box's key + network actually score a job (a revoked/typo'd key fails like a placeholder; `/api/health` never touches it).
- **Step 1 (now, isolates the key, <1¢):** run *only* `src/smoke/openrouter.smoke.test.ts` in the container — `docker compose exec -T app npx vitest run --config vitest.smoke.config.ts src/smoke/openrouter.smoke.test.ts`. NOT the full `smoke:real` (it bundles a prod-DB write + Chromium + a scrape).
- **Step 2 (go/no-go, AFTER the final pre-invite deploy):** the **fresh-account journey** in-browser — register with an invite code → onboarding → upload → scan → confirm a fresh `job_scores` row (`cost_usd > 0`, `model = 'openai/gpt-oss-120b'`). This validates onboarding-for-a-new-user *and* the paid path in one pass; today's box runs pre-perf code that ~30 commits will replace, so an E2E run now proves nothing.
- **Optional code:** `/api/health` gains `SELECT 1` + `llmKeyConfigured: !!process.env.OPENROUTER_API_KEY` (presence only — never a real LLM call from health).

### Task 2 — Off-box backups + restore drill  ·  BLOCKER  ·  ~45 min operator + 2-3 h repo
`/backups` is on the same disk as the data; no restore has ever been tested. (The uploads volume *is* already in the nightly cron — only off-box + encryption is missing.)
- `scripts/backup.sh` (repo-tracked at `/opt/caliber/scripts/backup.sh` so push-to-deploy maintains it): `VACUUM INTO` → tar uploads → `age -r <pubkey>` → `rclone` to **R2**. `.env.production` NOT automated (manual copy to password manager). The `age` **private key lives in two places** (Mac + password manager).
- **Restore drill (once, before invites, local):** pull → `age -d` → isolated `docker compose -p caliber-restore-drill` (distinct volumes, can't touch prod/dev) → log in, open a real résumé → `down -v`.
- Stale-backup alarm (no snapshot in ~26h) folds into Task 3.

### Task 3 — Alerting  ·  SPLIT: blocker slice + first-week slice
**Transport: Telegram bot** (operator prefers Telegram — Decision 1). A BotFather bot + the operator's chat_id; the alert script `curl`s the Telegram sendMessage API. (ntfy.sh was the brief's default; Telegram chosen for app consistency with the feedback channel.)
**Blocker slice (~30 min, operator, zero code):** UptimeRobot on `https://caliber.fightbase.co/api/health` (the only external check that sees DNS/TLS/host-Caddy) + the Telegram bot wired to push. This is launch-gate leg 4.
**First-week slice (~3 h repo):** `scripts/alert-check.sh` (repo-tracked) — the tiered log classifier. Only ~20 of the 27 in-process `console.error` sites are reachable by `docker compose logs app` (8 are one-off CLI scripts); classify **page-on-first** (crash/cost-cap/worker-loop) vs **page-above-threshold** (routine connector/scoring flakes) against exact literal substrings (a naive `grep -i error` pages on the *designed* fallback at `url-check/run.ts:202`). **Count-then-push-once**, **summary-only payloads** (never raw log lines to a third-party service — Telegram included), on-box `curl -f localhost:3000/api/health`, a `df` disk-full threshold line, and the stale-backup check. DEPLOY.md gets an "Alerting" section. Bot token lives in `/root/.config/caliber-alert.env` (box-only, not in git, not in `.env.production`).

### Task 4 — Error boundaries + crash beacon  ·  STRONG  ·  ~3 h
A client crash renders Next's white page with zero signal.
- **`src/app/error.tsx`** (NOT `global-error.tsx` — the root layout is 7 lines of static JSX that can't throw, so a root-level `error.tsx` sits inside it, catches AppShell/`(app)/layout` crashes, AND keeps `tokens.css` for free) + **`src/app/(app)/error.tsx`** (page crashes, shell preserved). Skip the thin `(auth)`/`(onboarding)` groups.
- **Beacon `POST /api/client-error`:** `ClientErrorReport` Zod schema, optional `getSession()` auth (unauth /login crash must still report), **userId server-side only**, size-cap before parse (413), **per-IP limit keyed off `X-Forwarded-For`** (behind host Caddy every socket is the proxy — without XFF the limiter throttles all friends as one bucket), 204. `sendBeacon` with a typed `Blob` + `fetch(keepalive)` fallback. Shared `reportClientError` helper. Logs `[client-error]` one-line JSON → feeds Task 3.
- Copy: honest, non-apologetic; support line links to the operator's Telegram (`https://t.me/<handle>`, hardcoded constant — Decision 1).

### Task 5 — PDPA pack: consent + delete-user  ·  STRONG  ·  ~4-4.5 h
**Consent:** full paragraph in the WhatsApp invite; a one-line caption on the register form (`AuthCard`'s caption style). **Collision note:** the credits work adds an invite-code field to the *same* `register/page.tsx` — since credits ships first, the caption slots alongside it. Frame as "PDPA-aware, best-effort," never "compliant."
**Delete runbook:** `src/server/persistence/delete-user.ts` (+ `user:delete` npm script). **13-table FK-safe order** (credits ships first, so `credit_ledger` is in the schema — the original 12 + ledger): sessions → applications → tailoredResumes → applicationAnswers → correlationReports → jobScores → **creditLedger** → urlChecks → searchRuns → jobs → resumes → profile → users; then `rm -rf ${uploadsRoot}/${userId}/`. Dry-run default, `--confirm` to mutate, re-runnable. Test: two full user graphs, delete one, assert zero rows across all 13 + second user untouched.

### Task 6 — Password reset + self-serve change-password  ·  STRONG  ·  ~5-6 h
Two parts (Decision 2 = build both):
- **Reset script** `reset-password.ts` (+ `auth:reset-password`): **generates** a 12-char typeable password and prints it (never argv — shared-box shell-history leak); two-invocation dry-run/`--confirm`; **kills all sessions** (new `sessionsRepo.deleteAllByUserId`; needs `usersRepo.updatePasswordHash`).
- **Self-serve change** `PATCH /api/auth/password` (reverify current password via `verifyPassword`, then `updatePasswordHash`) + a profile-page form, sharing the same two repo methods and the session-kill so a self-change also invalidates other sessions. Contract-first (new `ChangePasswordRequest` in `src/types` → regen).
**Collision note:** `repos/sessions.ts` (credits adds TTL) and `repos/users.ts` (credits adds `plan`) — credits-first dissolves it.

### Task 7 — Verdict-wrong feedback link  ·  STRONG  ·  ~1-1.5 h
One affordance on **`JobDetail` only** (feed rows / eval card funnel here anyway). A real `<a>` (kit `Button` has no `href`; mirror `AuthCard`'s quiet-link), quiet register (`--text-muted`, not brand red / danger tone). `src/caliber-ui/lib/feedback.ts` builds a **`https://t.me/share/url?url=<applyUrl>&text=<context>`** link (Decision 1 — Telegram); `text` carries title, company, tier, jobId, and a "what looks wrong:" lead-in covering both fit + legitimacy (no description — URL-length safe). The user taps once to pick the operator from their Telegram chat list. Operator handle is a hardcoded constant (`NEXT_PUBLIC_*` isn't wired into the Docker build). Graduates to a `verdict_feedback` table when reports get lost or at public launch.

### Task 8 — Weekly usage SQL  ·  STRONG  ·  ~1 h (cut from 8 queries to 3)
`scripts/usage.sql` (`.mode box`), run against an SSH'd **copy of the nightly snapshot**, never prod. **Three queries** (Fable cut the other five as n=20 noise): **legitimacy/verdict distribution** (the wedge-honesty check — if 99% `clear`, the wedge is decorative), **cost per user/feature**, **per-user activation funnel**. Documented caveats: epoch-ms (`/1000`); **`job_scores` upserts on rescan without touching `createdAt`, so cost-by-day is lossy** (but verdict/legitimacy distribution is correct — it wants latest-wins). Graduates to `/admin/usage` at ~50 users.

---

## Sequencing (Fable's verdict — credits first)

The credits work is execution-ready, operator-approved, gates the invites themselves, and owns four files this plan also touches (`register/page.tsx`, `repos/sessions.ts`, `repos/users.ts`, `src/types/index.ts`). Order:

1. **Now, box-side, no code collision:** Task 2 (backups + restore drill), Task 3 blocker slice (uptime + ntfy), Task 1 step 1 (API-only key check).
2. **Credits work:** build → merge → deploy (this also finally ships the ~30 unmerged perf/main commits the box is missing).
3. **This plan, on top of the credits merge:** Task 0 (transaction fixes) + Tasks 4-8 + Task 3 first-week slice. Branching after credits dissolves every cross-plan file collision.
4. **Task 1 step 2** (fresh-account E2E, invite code) against the final deployment. **Then invite.**

**Intra-plan collisions to sequence (not parallel-safe as first drafted):** Tasks 5 & 6 both edit `package.json`; Tasks 2 & 3 both edit `DEPLOY.md`; Task 4 edits `src/types/index.ts` + regenerates the contract. Serialize these touches or expect merge conflicts.

## Tracked risks (surface, decide, don't silently ship)

1. **SSRF DNS-rebind residual** — `src/server/url-check/ssrf.ts:6-10`'s own header calls the check-then-connect gap a "**Hard blocker before any hosted deploy**"; the app has been hosted since 2026-07-16. The guard is otherwise solid (resolved-address denylist: loopback/RFC1918/link-local/metadata/CGNAT) and exploiting the rebind window needs an authenticated user running a malicious DNS server — implausible at invite-only n≤20. **Recommendation: explicitly accept for the friends launch, note it here + amend the ssrf.ts comment, gate public launch on the undici connect-hook re-validation.**
2. **`/login` has no rate limit** — argon2id is CPU-heavy; bots find login forms regardless of invites → cheap CPU-exhaustion on a shared VPS. Recommendation: piggyback a per-IP limiter on the `RATE_LIMITED` idiom the credits work introduces. Small, not a blocker.
3. **No self-serve change-password** — Decision 2.
4. **`/api/health` reports `mode:'real'` even with a blank key** — Task 1's optional `llmKeyConfigured` closes it.

## Operator-only manual steps

Deploy the credits work; create the R2 bucket + scoped token (store in `/root/.config/caliber-backup.env`, NOT `.env.production`); generate the `age` keypair (private key → Mac + password manager); create the Telegram bot via BotFather + get your chat_id (token → `/root/.config/caliber-alert.env`); register UptimeRobot; set box env vars; raise `CALIBER_DAILY_LLM_USD` to 10 for launch (Decision 3); fill your Telegram handle into Task 4/7 (Decision 1); write the WhatsApp/Telegram invite paragraph with the consent notice.
