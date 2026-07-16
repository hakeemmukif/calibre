# Membership, Credits & Guardrails — Design Spec

Date: 2026-07-16. Status: **operator-approved design, pre-implementation.**
Companion visual: claude.ai/code artifact "Caliber — Membership & Guardrails" (credits-final).
Grounding: Fable code deep-read + competitor pricing research, both 2026-07-16.

## 1. Summary

Caliber monetizes with **prepaid credits, no subscription**: every user gets a one-time
30-credit signup bundle (never resets); LLM-spending actions debit credits at fixed
prices; when the wallet is empty they buy a **$5 pack = 150 credits** (credits never
expire; manual payment → admin grant while there is no payment processor). An
**Unlimited** plan, toggled per-user by the admin, skips debits entirely. The tracker
(applications, notes, statuses) is **never metered on any plan** — it is the retention
wedge. Riding along: the three pre-public tripwires close (session TTL, invite-gated
registration + per-IP limit, global cost cap re-scoped to a wallet circuit-breaker).

Why credits, not subscription: job search is episodic (hunt hard → land → leave);
packs monetize the burst instead of billing the guilt. One-off payments are trivially
manual with no processor; recurring manual collection is a monthly chore. All 8
researched competitors (Teal, Huntr, Simplify, Jobscan, Careerflow, LoopCV,
Resume Worded, Kickresume) are USD subscriptions at $29–50/mo; none price for
episodic hunts or SEA. Teal's free tier is itself a one-time non-resetting grant —
the shape is market-proven; the pack instead of a sub is the differentiator.

## 2. Operator-locked decisions (2026-07-16 — do not re-litigate)

| # | Decision | Value |
|---|----------|-------|
| 1 | Model | Prepaid credits; **no subscription**, no renewal dates |
| 2 | Signup bundle | **+30 credits**, one-time, never resets (sized so one full golden-path loop — extract 3 + scan 10 + evaluate 5 + tailor 8 = 26 — completes exactly once) |
| 3 | Pack | **$5 = 150 credits**, one global price, credits never expire |
| 4 | Debit prices | **scan 10 · tailor 8 · evaluate/url-check 5 · résumé extract 3 (whole pipeline) · apply answers 1 per question** |
| 5 | Never metered | Tracker: applications, notes, statuses, viewing jobs/scores already produced |
| 6 | Unlimited | `users.plan = 'unlimited'`, admin-toggled, skips debits; live on user's next request |
| 7 | Payments | None now. Manual: user pays (any channel) → admin grants +150. Stripe later = one checkout webhook writing the same ledger row |
| 8 | Registration | Invite gate: shared `CALIBER_INVITE_CODE` env var (rotatable), fail-loud if unset in prod; + per-IP in-memory limit 3 registrations/hour |
| 9 | Session TTL | 30-day **sliding** expiry (matches existing cookie maxAge); no absolute cap |
| 10 | Global cap | `CALIBER_DAILY_LLM_USD=5` **kept** as wallet circuit-breaker (runaway-bug protection), no longer a fairness tool |
| 11 | Audience | Invite-only testers ~3 months; open registration is out of scope |

## 3. Grounding (verified in code 2026-07-16)

- `users` has `role: user|admin` only — no plan/credits column (`src/server/persistence/schema.ts:314`).
- Sessions never expire server-side; `lastUsedAt` exists and is bumped (throttled 5 min) in `repos/sessions.ts`; cookie `maxAge` = 30d (`src/server/auth/session.ts`). Session resolution **joins `users` on every request** → plan/balance changes are live next request.
- Registration (`src/app/api/auth/register/route.ts`) is open: parse → create → auto-login.
- All LLM spend funnels through **8 server entry points**, each behind `requireUser()`:

| Route | Server entry | Credit price |
|---|---|---|
| `POST /api/search` | `startSearch` | 10 (flat per scan) |
| `POST /api/jobs/check` | `startUrlCheck` (enqueue) | 5 |
| `POST /api/jobs/[id]/evaluate` | `evaluateJob` | 5 |
| `POST /api/tailor/correlate` | `correlate` | 8 (charged once per tailor flow — at correlate admission; `startTailor` verifies a paid correlate rather than re-charging) |
| `POST /api/tailor` | `startTailor` | 0 (covered by correlate debit; assert linkage) |
| `POST /api/resume` | résumé extraction | 3 |
| `POST /api/apply/questions` | `extractQuestions` | 0 (extraction of questions is part of answers pricing) |
| `POST /api/apply/answers` | answer generation | 1 × number of questions in the request |

  *Implementation may re-map tailor/apply charging between their two routes if the flow
  reads better, as long as the flow total equals the locked prices (tailor flow = 8,
  answers = 1/question) and no path double-charges.*
- Cost per action (from `config/models.yml` rates; sonar per-request fee unmodeled): extract ~$0.001, evaluate $0.001–0.02, scan $0.01–0.05, tailor ~$0.006. Worst-case margins at pack rate ($0.033/credit): 6–30×.
- Existing global-cap idiom: `sumCostUsdSince(startOfToday())` in `src/server/search/run.ts` + `capReached()` in `src/server/url-check/worker.ts`; **cap never terminal-fails queued work** — quota must preserve this by checking at admission only.
- `ErrorCode` enum (`src/types/index.ts:330`) is additively extensible (proven by tests).

## 4. Design

### 4.1 Schema (one table + one column)

```ts
// credit_ledger — append-only; balance = SUM(delta) per user
export const creditLedger = sqliteTable("credit_ledger", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id),
  delta: integer("delta").notNull(),            // +grant / −debit, never 0
  reason: text("reason", { enum: ["signup", "purchase", "admin", "debit"] }).notNull(),
  feature: text("feature", { enum: ["scan", "evaluate", "tailor", "resume", "answers"] }), // debits only
  refId: text("ref_id"),                        // domain row the debit paid for (searchRun/urlCheck/…)
  createdAt: ..., // use the identical timestamp column helper the other tables in schema.ts use
});
// users: + plan
plan: text("plan", { enum: ["standard", "unlimited"] }).notNull(), // explicit at insert, no default
```

Migration backfill: existing `role='admin'` → `plan='unlimited'`; existing users →
`plan='standard'` **+ a `signup` grant row of +30** (they never got a bundle).
New registrations: `plan='standard'` + `signup` +30 row written in the same
transaction as user creation (one-time by construction — one signup row per user,
enforceable by a partial unique index on `(userId, reason)` where `reason='signup'`).

Indexes: `credit_ledger(user_id)` (balance query), the partial unique above.

### 4.2 Credits module — `src/server/credits/`

```ts
export const CREDIT_PRICES = { scan: 10, tailor: 8, evaluate: 5, resume: 3, answers: 1 } as const;
export async function balance(userId: string): Promise<number>;           // SUM(delta)
export async function assertAndDebit(user: AuthUser, feature: CreditFeature, opts?: { units?: number; refId?: string }): Promise<void>;
// throws InsufficientCreditsError { feature, required, balance }
```

Rules:
- **Admission-time, atomic.** Check + debit happen in one transaction (SQLite single
  writer + existing `busy_timeout=5000` make this safe). Debit is written before the
  work starts; a failed run does **not** refund automatically (spend happened) — the
  admin can compensate with a manual `admin` +delta row.
- **Bypass:** `user.plan === 'unlimited'` or `user.role === 'admin'` → no check, no debit row.
- `units` covers `answers` (1 × question count, known at admission from the request).
- The url-check **worker is untouched**: debits happen at enqueue admission; legally
  admitted queued rows always drain (preserves the existing cap invariant).
- No daily windows anywhere → the known `url_checks.createdAt` TZ oddity is
  irrelevant to enforcement (ledger `createdAt` is history only).

### 4.3 Wire contract

- `ErrorCode` + `"INSUFFICIENT_CREDITS"` → **HTTP 402** with
  `details: { feature, required, balance }`. Zod + OpenAPI regen (additive).
- `GET /api/credits` (requireUser) → `{ balance, plan }` for the header chip.
  (Alternatively piggyback on the existing session/user payload — implementer's call,
  contract-first either way.)

### 4.4 UI

- **Balance chip** in the app header (standard plan only; hidden for unlimited):
  `⬡ 17 credits`. Refreshes after any debiting action completes.
- **Empty-wallet modal** on 402: "Scans cost 10 credits — you have 7. Get 150
  credits for $5." Primary CTA = contact/pay instructions (manual for now);
  secondary = dismiss. Copy lives with the features layer that catches the error.
- **Admin users list** (exists): add balance + plan columns, a "+150 (pack)" button,
  an arbitrary ±delta input (reason `admin`), and the standard/unlimited toggle
  (`PATCH /api/admin/users/[id]`, requireAdmin).

### 4.5 Hygiene (rides along, orthogonal to credits)

1. **Session TTL** — in `findUserByTokenHash`: if `now − lastUsedAt > 30d`, delete the
   session row and return null. Zero schema change. Closes tripwire 2.
2. **Invite gate** — `RegisterRequest` + `inviteCode`; route 403s on mismatch with
   `CALIBER_INVITE_CODE` (fail-loud at boot if unset in production). Closes tripwire 1.
3. **Per-IP register limit** — in-memory Map, 3/hour/IP, 429 on excess. Correct
   because the app is one process by design (same assumption as the SSE registry).
4. **Global cap** — value stays $5/day; docs/comments updated to describe it as the
   operator's wallet circuit-breaker. Tripwire 3 is defused because per-user spend is
   bounded by purchased credits (free worst case: 30 credits ≈ ≤$1, ever).

### 4.6 Flows (acceptance narratives)

- **Wallet empties:** user with balance 7 starts a scan → 402 + modal; their running
  scan and queued url-checks are unaffected; they spend the 7 on an evaluate + answers
  or buy a pack; admin grants +150; next request reflects it.
- **Admin toggle:** admin sets plan=unlimited → user's next request skips all debits;
  chip disappears; ledger keeps their history.
- **Abuse:** without the invite code, registration 403s; 4th same-IP attempt in an
  hour 429s; a leaked code yields at most +30 credits per account ever (no resets to
  farm), visible in the admin list; operator rotates the env code and zeroes balances
  (admin −delta) or deletes accounts.

## 5. Testing

- **Unit (credits module):** balance math, atomic assert-and-debit, insufficient path,
  units multiplication, unlimited/admin bypass, signup-grant uniqueness.
- **Route contract:** each of the 8 entry points returns 402 with correct details when
  broke; debit row written with correct feature/refId on success; tailor flow charges
  exactly 8 total across correlate+tailor; answers charges 1×N.
- **Sessions:** token older than 30d sliding window → null + row deleted; fresh token
  unaffected; bump throttle still holds.
- **Register:** bad/missing invite → 403 and no rows (no user, no grant); 4th same-IP
  → 429; success writes user + signup grant atomically.
- **e2e (existing harness):** golden path on a fresh user consumes 26 credits and
  completes; the 27th-credit action 402s and shows the modal.

## 6. Rollout order

1. Session TTL (smallest diff, independent).
2. Invite gate + per-IP limit (closes the open door).
3. Schema (ledger + plan) + credits module + 402 contract.
4. Entry-point enforcement + header chip + modal.
5. Admin columns/actions.
6. Docs: DEPLOY.md tripwire section rewritten (closed items + circuit-breaker note);
   `.env.production.example` + box env gain `CALIBER_INVITE_CODE`.

## 7. Explicitly not built (YAGNI — agreed)

Stripe or any processor; subscriptions/renewals/proration; credit expiry; monthly
grant scheduler; per-user USD metering; Redis/external rate-limit store; email
verification (revisit at open registration); CAPTCHA; refund mechanics (manual admin
rows suffice); user-facing purchase-history page; "show score, sell the fix"
depth-gating (noted as a later conversion lever); per-invite-code DB rows (env var
until open beta).

## 8. Future notes (non-binding)

- **Stripe later:** one checkout → webhook writes `purchase` +150 row. Nothing else changes.
- **Subscription later** (if data shows repeat buyers): a monthly `purchase` grant row
  driven by the processor — the ledger already models it.
- **Open registration later:** swap invite env for per-invite rows, add email
  verification, revisit register rate limits and possibly CAPTCHA.
