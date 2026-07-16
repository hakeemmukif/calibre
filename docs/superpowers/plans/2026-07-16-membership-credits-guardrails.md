# Membership, Credits & Guardrails — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepaid credit metering on all 8 LLM-spend entry points (30-credit signup bundle, $5 = 150-credit packs via admin grant, admin-toggled Unlimited plan), plus the three pre-public tripwires: 30-day sliding session TTL, invite-gated registration with a per-IP limit, and the global cap re-scoped to a wallet circuit-breaker.

**Architecture:** One append-only `credit_ledger` table (balance = `SUM(delta)`) + a `users.plan` column. A `src/server/credits` module owns an **atomic single-statement guarded debit** (no `db.transaction` — see constraint below). Debits happen at admission inside the `server/*` functions, after their existing pre-flight validation throws and before any row insert / LLM call, so a broke user gets a synchronous HTTP 402 and never a failed background run. UI = balance chip + one shared insufficient-credits dialog fed by a `creditsStore` (mirrors `checksStore` idioms).

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Drizzle + SQLite (libsql `file:`), Zod contract in `src/types` → OpenAPI, Vitest, Playwright.

**Source spec:** `docs/superpowers/specs/2026-07-16-membership-credits-guardrails-design.md` (operator-approved; §2 decisions are locked — do not re-litigate).

## Global Constraints

- **NEVER use `db.transaction()`.** @libsql/client's `file:` driver recreates its connection when an interactive transaction begins; concurrent transactions corrupt state (verified twice on 2026-07-16 during perf/scan-overhead; `src/server/persistence/test-db.ts` header documents it). Atomicity comes from single guarded SQL statements — the same idiom as `urlChecksRepo.claimNextQueued`.
- **Prices (locked):** scan 10 · tailor flow 8 · evaluate/url-check 5 · résumé extract 3 · answers 1/question. Signup bundle +30 one-time. Pack +150.
- **Bypass:** `plan === 'unlimited'` OR `role === 'admin'` → no check, no ledger row.
- **Debit at admission, after existing validation throws, before work starts.** No automatic refunds — admin compensates with a manual `admin` row.
- **The url-check worker (`src/server/url-check/worker.ts`) is untouched.** Admitted queued rows always drain.
- **Tracker is never metered** (applications, notes, statuses, viewing existing jobs/scores).
- **Fail loud:** no fallback defaults; `Schema.parse` at boundaries; explicit values at insert (no relying on the migration's DB-level default in app code).
- **Multitenant scoping preserved:** every repo read stays scoped by `userId`.
- **Contract-first:** any change to `src/types` → `npm run contract` and commit `contract/openapi.json` in the same commit.
- **Route tests:** `requireUser` is mocked; **the default mock user is `role: "admin"` which bypasses credits** — 402/debit tests MUST mock a non-admin user (`role: "user"`) whose row exists in the test DB with `plan: 'standard'`.
- **`.env*` files are read-denied to agents.** Modify `.env.production.example` only via shell append (`echo >> …`); never attempt Read/Edit on it.
- **Branch:** `feat/membership-credits` from current `main`. The commit hook runs `tsc` from the session cwd — keep every commit typecheck-green.
- **Kit canon:** compose the 13 primitives in `src/caliber-ui/components` (Chip, Card, Button, Input, Tag, Icon…); match `tokens.css` values; no new design language.

## Operator UX decisions (2026-07-16, supplements spec §2 — locked)

Resolved during planning (the spec's bundle math assumed one scan in the golden path; the code fired two):

1. **Résumé upload no longer auto-starts any scan.** The dual-persona `Promise.allSettled` kickoff in `src/app/(app)/resume/page.tsx` is removed.
2. **After extraction, show the résumé first**, then prompt: proceed to scan? User picks **one** persona (remote/local) explicitly; each scan debits 10.
3. **Upload shows what's happening** — use the kit's existing `parsing` status with duration-honest copy.
4. **Scan list rows label their persona** (remote/local Tag).

Golden path stays within the bundle: extract 3 + scan 10 + evaluate 5 + tailor 8 = 26 ≤ 30. ✓

---

### Task 1: Sliding 30-day session TTL

**Files:**
- Modify: `src/server/persistence/repos/sessions.ts` (findUserByTokenHash, ~lines 20-35)
- Test: `src/server/persistence/repos/sessions.test.ts`

**Interfaces:**
- Consumes: existing `findUserByTokenHash(tokenHash): Promise<UserRow | null>` and its 5-minute `LAST_USED_BUMP_MS` throttle (already shipped).
- Produces: same signature; a session whose `lastUsedAt` is >30 days old resolves `null` and its row is deleted.

- [ ] **Step 1: Write the failing tests** (append to the existing describe block; mirror the throttle tests' direct-DB seeding style):

```ts
it("deletes and rejects a session idle for more than 30 days", async () => {
  const db = await createTestDb();
  const u = await seedUser(db);
  const repo = createSessionRepo(db);
  await repo.create({ userId: u.id, tokenHash: "old" });
  const idle = new Date(Date.now() - 31 * 24 * 60 * 60_000); // 31 days
  await db.update(sessions).set({ lastUsedAt: idle }).where(eq(sessions.tokenHash, "old"));

  expect(await repo.findUserByTokenHash("old")).toBeNull();
  const [row] = await db.select().from(sessions).where(eq(sessions.tokenHash, "old"));
  expect(row).toBeUndefined(); // row deleted, not just rejected
});

it("a session idle 29 days still resolves (sliding window)", async () => {
  const db = await createTestDb();
  const u = await seedUser(db);
  const repo = createSessionRepo(db);
  await repo.create({ userId: u.id, tokenHash: "fresh30" });
  const idle = new Date(Date.now() - 29 * 24 * 60 * 60_000);
  await db.update(sessions).set({ lastUsedAt: idle }).where(eq(sessions.tokenHash, "fresh30"));

  const found = await repo.findUserByTokenHash("fresh30");
  expect(found?.id).toBe(u.id);
});
```

- [ ] **Step 2: Run to verify both fail**

Run: `npx vitest run src/server/persistence/repos/sessions.test.ts`
Expected: FAIL — first test gets a user back instead of null.

- [ ] **Step 3: Implement.** In `sessions.ts`, add next to `LAST_USED_BUMP_MS`:

```ts
// Sliding session TTL (membership spec §4.5.1): a session idle past this is
// dead — delete the row and treat the token as unknown. Mirrors the 30-day
// cookie maxAge in src/server/auth/session.ts (THIRTY_DAYS); change both
// together.
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
```

In `findUserByTokenHash`, after `if (!row) return null;` and **before** the bump-throttle block:

```ts
if (Date.now() - row.lastUsedAt.getTime() > SESSION_TTL_MS) {
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
  return null;
}
```

Also add the cross-reference comment on `THIRTY_DAYS` in `src/server/auth/session.ts:9`: `// mirrored by SESSION_TTL_MS in repos/sessions.ts — change both together.`

- [ ] **Step 4: Run tests** — `npx vitest run src/server/persistence/repos/sessions.test.ts src/server/auth/session.test.ts src/app/api/auth/auth.route.test.ts`. Expected: all PASS (throttle tests unaffected: 1-min/6-min offsets are far below 30d).

- [ ] **Step 5: Commit** — `git commit -m "feat(auth): 30-day sliding session TTL"`

---

### Task 2: Invite-gated registration + per-IP limit

**Files:**
- Modify: `src/types/index.ts` (`RegisterRequest` ~line 447; `ErrorCode` ~line 330)
- Create: `src/server/auth/registerLimit.ts`
- Test: `src/server/auth/registerLimit.test.ts`
- Modify: `src/app/api/auth/register/route.ts`
- Modify: `instrumentation.ts` (boot fail-loud)
- Modify: `src/app/(auth)/register/page.tsx` (invite field)
- Modify: `contract/openapi.json` (regen)
- Test: extend `src/app/api/auth/auth.route.test.ts`

**Interfaces:**
- Consumes: `RegisterRequest` Zod schema; the route's local `errorResponse` helper.
- Produces: `RegisterRequest` gains `inviteCode: z.string().min(1)`; `ErrorCode` gains `"RATE_LIMITED"`; `checkRegisterLimit(ip: string, now?: number): boolean` (true = allowed). Task 3 wires the signup grant into this route.

- [ ] **Step 1: Failing route tests** (in `auth.route.test.ts`, mirror its request-builder idiom; set `process.env.CALIBER_INVITE_CODE = "e2e-invite"` in `beforeEach`, delete in `afterEach`):

```ts
it("403s FORBIDDEN on wrong invite code, creating nothing", async () => {
  const res = await POST(jsonRequest({ email: "a@x.co", password: "hunter2hunter2", inviteCode: "wrong" }));
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe("FORBIDDEN");
  // no user row
  expect(await state.testDb.select().from(users).where(eq(users.email, "a@x.co"))).toHaveLength(0);
});

it("422s when inviteCode is missing entirely", async () => {
  const res = await POST(jsonRequest({ email: "a@x.co", password: "hunter2hunter2" }));
  expect(res.status).toBe(422);
});

it("429s RATE_LIMITED on the 4th registration from one IP inside an hour", async () => {
  for (let i = 0; i < 3; i++) {
    const res = await POST(jsonRequest(
      { email: `u${i}@x.co`, password: "hunter2hunter2", inviteCode: "e2e-invite" },
      { "x-forwarded-for": "203.0.113.9" },
    ));
    expect(res.status).toBe(201);
  }
  const res = await POST(jsonRequest(
    { email: "u3@x.co", password: "hunter2hunter2", inviteCode: "e2e-invite" },
    { "x-forwarded-for": "203.0.113.9" },
  ));
  expect(res.status).toBe(429);
  expect((await res.json()).error.code).toBe("RATE_LIMITED");
});
```

(Extend the file's `jsonRequest` helper to accept extra headers; call `__resetRegisterLimitForTests()` in `beforeEach`.)

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/app/api/auth/auth.route.test.ts`.

- [ ] **Step 3: Implement.**

`src/types/index.ts`: add `inviteCode: z.string().min(1),` to `RegisterRequest`; add `"RATE_LIMITED",` to the `ErrorCode` enum (before `"INTERNAL"`).

`src/server/auth/registerLimit.ts` (globalThis-guarded like `runs/registry.ts` — next dev bundle duplication):

```ts
// Per-IP registration limit (membership spec §4.5.3): 3/hour fixed window,
// in-memory. Correct because the app is one process by design (same
// assumption as the SSE run registry).
const WINDOW_MS = 60 * 60_000;
const MAX_PER_WINDOW = 3;

type Bucket = { windowStart: number; count: number };
const g = globalThis as unknown as { __caliberRegisterLimiter?: Map<string, Bucket> };
g.__caliberRegisterLimiter ??= new Map();
const buckets = g.__caliberRegisterLimiter;

export function checkRegisterLimit(ip: string, now = Date.now()): boolean {
  const b = buckets.get(ip);
  if (!b || now - b.windowStart >= WINDOW_MS) {
    buckets.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  if (b.count >= MAX_PER_WINDOW) return false;
  b.count += 1;
  return true;
}

export function __resetRegisterLimitForTests(): void {
  buckets.clear();
}
```

`register/route.ts`, inside the try after `RegisterRequest.parse(json)` (destructure `inviteCode` too), before any DB write:

```ts
const expected = process.env.CALIBER_INVITE_CODE;
if (!expected) throw new Error("CALIBER_INVITE_CODE is not set — registration is invite-gated (membership spec §4.5.2).");
if (inviteCode !== expected) return errorResponse(403, "FORBIDDEN", "Invalid invite code.");

// Behind the host Caddy proxy the client IP is the first x-forwarded-for
// entry; a missing header (direct local dev) degrades to one shared bucket,
// which is stricter, never looser.
const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
if (!checkRegisterLimit(ip)) return errorResponse(429, "RATE_LIMITED", "Too many registrations from this address — try again in an hour.");
```

`instrumentation.ts`, first thing inside the `NEXT_RUNTIME === "nodejs"` block:

```ts
if (process.env.NODE_ENV === "production" && !process.env.CALIBER_INVITE_CODE) {
  throw new Error("CALIBER_INVITE_CODE must be set in production — registration invite gate (membership spec §4.5.2).");
}
```

`src/app/(auth)/register/page.tsx`: add an `inviteCode` state + kit `Input` (label "Invite code", `required`) alongside email/password; include it in the `register({ email, password, inviteCode })` call (the widened `RegisterRequest` type carries it through `features/auth/client.ts` with no client change).

- [ ] **Step 4: Unit tests for the limiter** (`registerLimit.test.ts`): 3 allowed then 4th denied; different IP unaffected; window expiry re-allows (pass `now` explicitly — no fake timers needed).

- [ ] **Step 5: Regen contract + run** — `npm run contract && npx vitest run src/app/api/auth/auth.route.test.ts src/server/auth/registerLimit.test.ts src/features/auth`. Expected: PASS. Add dev default so local registration keeps working: `echo 'CALIBER_INVITE_CODE=dev-invite' >> .env` (shell append — file is read-denied; confirm with the operator if unsure the key isn't already set: `grep -c CALIBER_INVITE_CODE .env`).

- [ ] **Step 6: Commit** — `git commit -m "feat(auth): invite-gated registration + per-IP limit"`

---

### Task 3: Schema — `credit_ledger` + `users.plan` + backfill migration

**Files:**
- Modify: `src/server/persistence/schema.ts` (users table ~line 329; new table after it)
- Modify: `src/server/persistence/repos/users.ts` (create ~line 28; `UserRow` if it's an explicit type)
- Modify: `src/server/persistence/seed.ts` (seedAdmin ~line 76)
- Modify: `src/app/api/auth/register/route.ts` (signup grant — depends on Task 4's `grant`, see note)
- Create: `drizzle/0002_*.sql` (generated, then hand-edited)
- Test: extend `src/server/persistence/repos/users.test.ts` (or the closest existing users repo test file)

**Interfaces:**
- Consumes: schema idioms (`timestamp_ms` helper, `uniqueIndex(...).where(sql\`...\`)` as in `resumes_user_id_active_unique`).
- Produces: `creditLedger` drizzle table export; `users.plan: "standard" | "unlimited"`; `usersRepo.create` writes `plan: "standard"` explicitly; `seedAdmin` writes `plan: "unlimited"`.

**Note on ordering:** the register-route signup grant needs Task 4's `grant()`. Implement the schema + repos here; the route grant lands in Task 4 Step 6 so this task stays independently green.

- [ ] **Step 1: Schema.** Add to `schema.ts`:

```ts
// Membership spec §4.1 — append-only; balance = SUM(delta) per user. No
// updates, no deletes: refunds/corrections are new rows (reason 'admin').
export const creditLedger = sqliteTable(
  "credit_ledger",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull().references(() => users.id),
    delta: integer("delta").notNull(), // +grant / −debit, never 0 (asserted in server/credits)
    reason: text("reason", { enum: ["signup", "purchase", "admin", "debit"] }).notNull(),
    feature: text("feature", { enum: ["scan", "evaluate", "tailor", "resume", "answers"] }), // debits only
    refId: text("ref_id"), // domain row the debit paid for (searchRun/urlCheck/…)
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    index("credit_ledger_user_id_idx").on(t.userId),
    // one-time signup bundle by construction — a second 'signup' row for a
    // user violates this index.
    uniqueIndex("credit_ledger_signup_once").on(t.userId).where(sql`${t.reason} = 'signup'`),
  ],
);
```

To `users`, after `role`:

```ts
plan: text("plan", { enum: ["standard", "unlimited"] }).notNull(), // written explicitly at insert — no drizzle default (no-fallback); the migration's DB default exists only to satisfy ALTER on existing rows
```

- [ ] **Step 2: Generate + hand-edit the migration.** Run `npm run db:generate`. Drizzle will emit `drizzle/0002_<name>.sql` with `CREATE TABLE credit_ledger…`, the two indexes, and `ALTER TABLE users ADD plan text NOT NULL;` — **which fails on a non-empty table.** Hand-edit that line and append the backfill:

```sql
ALTER TABLE `users` ADD `plan` text NOT NULL DEFAULT 'standard';--> statement-breakpoint
UPDATE users SET plan = 'unlimited' WHERE role = 'admin';--> statement-breakpoint
INSERT INTO credit_ledger (id, user_id, delta, reason, created_at)
SELECT lower(hex(randomblob(16))), id, 30, 'signup', CAST(strftime('%s','now') AS INTEGER) * 1000
FROM users WHERE plan = 'standard';
```

(Existing standard users get the bundle they never had — spec §4.1. Admins are unlimited and need no grant. Do NOT run `db:migrate` against the dev DB in this task; `createTestDb()` executes `drizzle/*.sql` directly, so tests pick it up automatically.)

- [ ] **Step 3: Failing repo test:**

```ts
it("create writes plan 'standard' explicitly; seedAdmin writes 'unlimited'", async () => {
  const db = await createTestDb();
  const repo = createUserRepo(db);
  const u = await repo.create({ email: "p@x.co", passwordHash: "h", role: "user" });
  expect(u.plan).toBe("standard");
  const [admin] = await seedAdmin(db, { email: "root@x.co", password: "hunter2hunter2" });
  expect(admin.plan).toBe("unlimited");
});
```

- [ ] **Step 4: Implement repos.** `usersRepo.create`: add `plan: "standard" as const` to the insert values (signature unchanged — new accounts are always standard; unlimited is admin-toggled later). `seedAdmin`: add `plan: "unlimited"` to both `values` and the `onConflictDoUpdate` `set`.

- [ ] **Step 5: Run** — `npx vitest run src/server/persistence/repos/ src/app/api/auth/auth.route.test.ts`. Expected: PASS (migration applies in every `createTestDb`).

- [ ] **Step 6: Commit** — `git commit -m "feat(credits): credit_ledger table + users.plan with backfill"`

---

### Task 4: Credits module — atomic guarded debit

**Files:**
- Create: `src/server/credits/index.ts`
- Test: `src/server/credits/credits.test.ts`
- Modify: `src/app/api/auth/register/route.ts` (signup grant)
- Test: extend `src/app/api/auth/auth.route.test.ts`

**Interfaces:**
- Consumes: `creditLedger`, `users` from schema; `getDb()`.
- Produces (used by Tasks 5–10):

```ts
export const CREDIT_PRICES = { scan: 10, tailor: 8, evaluate: 5, resume: 3, answers: 1 } as const;
export type CreditFeature = keyof typeof CREDIT_PRICES;
export class InsufficientCreditsError extends Error {
  readonly feature: CreditFeature; readonly required: number; readonly balance: number;
}
export async function balance(userId: string): Promise<number>;
export async function grant(userId: string, delta: number, reason: "signup" | "purchase" | "admin", refId?: string): Promise<void>; // throws on delta === 0 or non-integer
export async function assertAndDebit(userId: string, feature: CreditFeature, opts?: { units?: number; refId?: string }): Promise<void>;
```

- [ ] **Step 1: Failing unit tests** (real `createTestDb` via the `vi.mock("@/server/persistence/db")` idiom from route tests; seed one standard user, one admin, one unlimited user):

```ts
it("balance sums the ledger; empty ledger is 0", …);
it("grant then debit: assertAndDebit writes a negative row with feature+refId", …);
it("insufficient: throws InsufficientCreditsError carrying {feature, required, balance}; writes NO row", …);
it("units multiply: answers ×4 debits 4", …);
it("unlimited plan and admin role bypass — resolve without writing any row", …);
it("grant rejects delta 0 and non-integers (fail loud)", …);
it("a second 'signup' grant for the same user throws (partial unique index)", …);
it("concurrency: balance 30, five concurrent scan debits (10 each) → exactly 3 succeed, balance lands at exactly 0, never negative", async () => {
  await grant(u.id, 30, "admin");
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => assertAndDebit(u.id, "scan")),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
  expect(await balance(u.id)).toBe(0);
});
```

**Deliberate deviation from spec §4.2's sketch:** the spec sketched `assertAndDebit(user: AuthUser, …)`, but `AuthUser` does not carry `plan` (and widening it churns every auth response). This module takes `userId` and reads `plan`/`role` itself — one cheap indexed select per debiting action — which also makes an admin's plan toggle live on the very next request (spec §2.6) with zero session invalidation.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/server/credits/credits.test.ts` → module not found.

- [ ] **Step 3: Implement `src/server/credits/index.ts`:**

```ts
// Membership spec §4.2. Admission-time, atomic, and deliberately WITHOUT
// db.transaction(): @libsql/client's file: driver recreates its connection
// when an interactive transaction begins, and concurrent transactions
// corrupt state (perf/scan-overhead 2026-07-16; test-db.ts header). The
// guarded INSERT…SELECT…WHERE below is race-free under SQLite's
// single-writer serialization — the same idiom as claimNextQueued.
import { eq, sql, sum } from "drizzle-orm";
import { getDb } from "@/server/persistence/db";
import { creditLedger, users } from "@/server/persistence/schema";

export const CREDIT_PRICES = { scan: 10, tailor: 8, evaluate: 5, resume: 3, answers: 1 } as const;
export type CreditFeature = keyof typeof CREDIT_PRICES;

export class InsufficientCreditsError extends Error {
  constructor(
    readonly feature: CreditFeature,
    readonly required: number,
    readonly balance: number,
  ) {
    super(`Insufficient credits: ${feature} needs ${required}, balance is ${balance}.`);
    this.name = "InsufficientCreditsError";
  }
}

export async function balance(userId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ total: sum(creditLedger.delta) })
    .from(creditLedger)
    .where(eq(creditLedger.userId, userId));
  return Number(row?.total ?? 0);
}

export async function grant(
  userId: string,
  delta: number,
  reason: "signup" | "purchase" | "admin",
  refId?: string,
): Promise<void> {
  if (!Number.isInteger(delta) || delta === 0) throw new Error(`credit grant delta must be a non-zero integer, got ${delta}`);
  await getDb().insert(creditLedger).values({ userId, delta, reason, refId: refId ?? null });
}

export async function assertAndDebit(
  userId: string,
  feature: CreditFeature,
  opts: { units?: number; refId?: string } = {},
): Promise<void> {
  const units = opts.units ?? 1;
  if (!Number.isInteger(units) || units < 1) throw new Error(`debit units must be a positive integer, got ${units}`);
  const db = getDb();
  const [u] = await db.select({ plan: users.plan, role: users.role }).from(users).where(eq(users.id, userId));
  if (!u) throw new Error(`assertAndDebit: unknown user ${userId}`);
  if (u.plan === "unlimited" || u.role === "admin") return;

  const required = CREDIT_PRICES[feature] * units;
  const res = await db.run(sql`
    INSERT INTO credit_ledger (id, user_id, delta, reason, feature, ref_id, created_at)
    SELECT ${crypto.randomUUID()}, ${userId}, ${-required}, 'debit', ${feature}, ${opts.refId ?? null}, ${Date.now()}
    WHERE (SELECT COALESCE(SUM(delta), 0) FROM credit_ledger WHERE user_id = ${userId}) >= ${required}
  `);
  if (res.rowsAffected === 0) throw new InsufficientCreditsError(feature, required, await balance(userId));
}
```

- [ ] **Step 4: Run tests** — all PASS, concurrency test included.

- [ ] **Step 5: Signup grant in the register route.** After `usersRepo.create(...)` in `register/route.ts`:

```ts
// One-time bundle (spec §2.2). Sequential with the user insert rather than a
// transaction (see credits module header for why); the signup partial-unique
// index makes it one-time by construction. A crash between the two inserts
// leaves a zero-balance account — visible in the admin list, compensated
// with an admin grant (same compensation model as failed-run debits).
await grant(user.id, 30, "signup");
```

Route test: successful register → ledger has exactly one `signup` +30 row for the new user; 403/422/429 paths → zero ledger rows.

- [ ] **Step 6: Run + commit** — `npx vitest run src/server/credits src/app/api/auth/auth.route.test.ts` → PASS. `git commit -m "feat(credits): credits module with atomic guarded debit + signup grant"`

---

### Task 5: Wire contract — 402 envelope + `GET /api/credits`

**Files:**
- Modify: `src/types/index.ts` (`ErrorCode`; new `CreditsResponse`)
- Create: `src/app/api/credits/route.ts`
- Test: `src/app/api/credits/route.test.ts`
- Modify: `src/contract/registry.ts`, regen `contract/openapi.json`

**Interfaces:**
- Consumes: `balance()` from Task 4; `requireUser`.
- Produces: `ErrorCode` gains `"INSUFFICIENT_CREDITS"`; `CreditsResponse = z.object({ balance: z.number().int(), plan: z.enum(["standard", "unlimited"]) })`; the canonical 402 catch-branch pattern Tasks 6–7 copy into each route:

```ts
if (err instanceof InsufficientCreditsError) {
  return errorResponse(402, "INSUFFICIENT_CREDITS", err.message, {
    feature: err.feature, required: err.required, balance: err.balance,
  });
}
```

- [ ] **Step 1: Failing route test** (mock `requireUser`; seed a standard user with a couple of ledger rows): 401 without session; 200 `{ balance: 25, plan: "standard" }` after +30/−5 rows; admin gets their own plan value (`unlimited` via seeded admin).

- [ ] **Step 2: Implement.** Types: add `"INSUFFICIENT_CREDITS",` to `ErrorCode`; add `CreditsResponse` near `AuthUser`. Route (mirror an existing thin GET route's shape, e.g. admin users):

```ts
import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/session";
import { UnauthorizedError } from "@/server/auth/errors";
import { balance } from "@/server/credits";
import { usersRepo } from "@/server/persistence/repos/users";
import { CreditsResponse } from "@/types";

export async function GET() {
  try {
    const session = await requireUser();
    const user = await usersRepo.getById(session.id); // add getById if absent — single select by id, throws-free null
    if (!user) throw new Error(`credits: session user ${session.id} has no users row`);
    return NextResponse.json(CreditsResponse.parse({ balance: await balance(session.id), plan: user.plan }));
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Sign in required." } }, { status: 401 });
    }
    throw err;
  }
}
```

Registry: `registry.registerPath({ method: "get", path: "/api/credits", summary: "Wallet balance + plan for the header chip", responses: { 200: {…CreditsResponse…}, 401: {…ErrorEnvelope…} } })` following the existing block style.

- [ ] **Step 3: Regen + run + commit** — `npm run contract && npx vitest run src/app/api/credits` → PASS. `git commit -m "feat(credits): GET /api/credits + INSUFFICIENT_CREDITS contract"`

---

### Task 6: Enforcement — scan, url-check, evaluate

**Files:**
- Modify: `src/server/search/run.ts` (`startSearch`, after source validation ~line 127, before `searchRunsRepo.insert`)
- Modify: `src/server/url-check/run.ts` (`startUrlCheck` ~line 308, queue path only ~line 350)
- Modify: `src/server/score/evaluate.ts` (`evaluateJob` ~line 22)
- Modify routes: `src/app/api/search/route.ts`, `src/app/api/jobs/check/route.ts`, `src/app/api/jobs/[id]/evaluate/route.ts` (402 branch each)
- Tests: extend `src/server/search/run.test.ts`, `src/server/url-check/run.test.ts`, and the three route test files

**Interfaces:**
- Consumes: `assertAndDebit`, `InsufficientCreditsError` (Task 4), 402 branch pattern (Task 5).
- Produces: debit rows `feature: "scan"` (refId = runId), `"evaluate"` (refId = urlCheck id / jobId).

- [ ] **Step 1: Failing server tests** (each file already builds real test DBs; seed a `role:"user"`, `plan:"standard"` user with a known balance — **not** BOOTSTRAP_ADMIN_ID, which bypasses):

```ts
it("startSearch debits 10 with refId = run id; insufficient balance throws before any search_runs row exists", …);
it("startSearch does NOT debit when pre-flight fails (no résumé): balance unchanged after NoActiveResumeError", …);
it("startUrlCheck queue path debits 5 with refId = the url_checks row id", …);
it("startUrlCheck alreadyKnown short-circuit is free (no ledger row)", …);
it("evaluateJob debits 5 with refId = jobId; UnknownJobError path debits nothing", …);
it("admin/unlimited users run all three with zero ledger rows", …);
```

- [ ] **Step 2: Implement admission debits.**

`startSearch` — after the `scopedSources` validation, immediately before `searchRunsRepo.insert` (inside the existing try, so the catch's slot-release + synthetic terminal emit handle the throw):

```ts
// Admission debit (membership spec §4.2): after every pre-flight throw
// (conflict/resume/profile/sources) so a rejected start never charges,
// before the row insert so a charged start always has its run.
await assertAndDebit(userId, "scan", { refId: runId });
```

`startUrlCheck` — locate the two insert paths. The alreadyKnown short-circuit (~line 332) stays free. On the queue path (~line 350), pregenerate the id so the debit can reference it:

```ts
const checkId = crypto.randomUUID();
await assertAndDebit(userId, "evaluate", { refId: checkId });
const row = await urlChecksRepo.insert({ id: checkId, /* …existing fields unchanged… */ });
```

(`NewUrlCheck` is `$inferInsert` — explicit `id` is accepted; verify the existing insert call and thread `id` through.)

`evaluateJob` — after its job-existence/ownership validation, before any LLM work:

```ts
await assertAndDebit(userId, "evaluate", { refId: jobId });
```

- [ ] **Step 3: Route 402 branches + tests.** Copy the Task 5 catch branch into each of the three routes' catch chains (each route has a local `errorResponse` — match its shape). Route tests: broke standard user → 402 with `{ feature, required, balance }` details; assert the response parses against `ErrorEnvelope`.

- [ ] **Step 4: Run + commit** — `npx vitest run src/server/search/run.test.ts src/server/url-check/run.test.ts src/server/score src/app/api/search src/app/api/jobs` → PASS. `git commit -m "feat(credits): admission debits for scan, url-check, evaluate"`

---

### Task 7: Enforcement — tailor flow (8 total, once), résumé, answers

**Files:**
- Modify: `src/server/tailor/correlate.ts` (`correlate` ~line 152 — add `opts` param + debit)
- Modify: `src/server/tailor/index.ts` (`startTailor` ~line 114 admission; internal call ~line 237)
- Modify: `src/server/resume/ingest.ts` (`ingestResume` ~line 118)
- Modify: `src/server/apply-assistant/answer.ts` (`draftAnswers` ~line 59)
- Modify routes: `src/app/api/tailor/correlate/route.ts`, `src/app/api/tailor/route.ts`, `src/app/api/resume/route.ts`, `src/app/api/apply/answers/route.ts` (402 branches)
- Tests: extend `src/server/tailor/correlate.test.ts`, `src/server/tailor/tailor.test.ts`, resume ingest tests, apply-assistant tests, + the four route test files

**Interfaces:**
- Consumes: Task 4 module; Task 5 pattern.
- Produces: `correlate(userId, input, deps?, opts?: { prepaid?: boolean })`. **Flow invariant: exactly one 8-credit debit per tailor flow, always at a synchronous admission point** — never inside the background `runTailorJob`/`runCorrelateJob` (a 402 there could not reach the user; it would just fail the run).

- [ ] **Step 1: Failing flow tests:**

```ts
it("correlate (route path) debits 8 once, refId = report id, AFTER NoJdFactsError can throw (no charge on 409)", …);
it("startTailor with a reportId debits nothing (flow already paid at correlate)", …);
it("startTailor WITHOUT reportId debits 8 at admission and its internal correlate call is prepaid — total across the whole flow is exactly one −8 row", …);
it("startTailor without reportId pre-checks jdFacts and throws NoJdFactsError BEFORE debiting", …);
it("ingestResume debits 3 at admission before extraction", …);
it("draftAnswers debits 1 × questions.length; extractQuestions writes no ledger row", …);
```

- [ ] **Step 2: Implement.**

`correlate.ts` — widen the signature and debit after the last validation throw, pregenerating the report id:

```ts
export async function correlate(
  userId: string,
  input: { jobId: string },
  deps: CorrelateDeps = {},
  opts: { prepaid?: boolean } = {},
): Promise<CorrelationReport> {
  // …existing UnknownJobError / NoActiveResumeError / NoJdFactsError checks unchanged…
  const reportId = crypto.randomUUID();
  // The tailor-without-report flow already debited 8 at ITS admission and
  // calls this from the background job with prepaid — a debit here would
  // double-charge, and a 402 here could never reach the user.
  if (!opts.prepaid) await assertAndDebit(userId, "tailor", { refId: reportId });
  const inserted = await correlationReportsRepo.insert({ id: reportId, /* …existing fields… */ });
  // …rest unchanged…
}
```

`tailor/index.ts` `startTailor` — in the existing admission section (before `tailoredResumesRepo.insert`):

```ts
if (!input.reportId) {
  // Direct-tailor path: correlate runs later inside the background job, so
  // its own validations would fire after admission — pre-check the one that
  // gates the whole flow (same check correlate does) BEFORE charging.
  const scoreRow = await jobScoresRepo.getLatestByJobId(input.jobId);
  if (!scoreRow?.jdFacts) throw new NoJdFactsError(input.jobId);
  await assertAndDebit(userId, "tailor", { refId: input.jobId });
}
```

And at ~line 237, mark the internal call prepaid: `const started = await correlate(row.userId, { jobId: row.jobId }, deps, { prepaid: true });`

`ingest.ts` `ingestResume` — after input validation, before extraction/LLM: `await assertAndDebit(userId, "resume");` (no refId — the resume row doesn't exist yet; ledger still carries user/feature/time).

`answer.ts` `draftAnswers` — at admission: `await assertAndDebit(userId, "answers", { units: input.questions.length });`

`extractQuestions` — no change (0-credit by spec §3; the test pins it).

- [ ] **Step 3: Route 402 branches** in the four routes + route tests (broke user → 402 details correct; `POST /api/tailor` with reportId never 402s for credits).

- [ ] **Step 4: Run + commit** — `npx vitest run src/server/tailor src/server/resume src/server/apply-assistant src/app/api/tailor src/app/api/resume src/app/api/apply` → PASS. `git commit -m "feat(credits): tailor-flow single 8-credit debit + resume + answers"`

---

### Task 8: Résumé flow rework + scan persona labels (operator UX decisions)

**Files:**
- Modify: `src/app/(app)/resume/page.tsx` (remove dual kickoff; add review + scan prompt)
- Modify: `src/caliber-ui/compositions/Resume/ResumeUpload.tsx` (parsing copy, line 112)
- Modify: `src/caliber-ui/compositions/Scans/ScansList.tsx` (persona Tag)
- Modify: `src/features/resume/client.ts` (only if upload status staging needs it — expected: no change)
- Tests: `src/caliber-ui/compositions/Scans/ScansList.dom.test.tsx`; extend resume page test if `src/app/(app)/resume/page.test.tsx` exists (it does — the scout saw it referenced as a harness example)
- Modify: `e2e/resume-scan-feed.spec.ts` (flow now needs an explicit scan click)

**Interfaces:**
- Consumes: `startSearch({ persona })` from `features/search/client`; `ResumeUploadStatus` already includes `"parsing"`.
- Produces: upload → **no auto-scan**; a post-upload prompt starts exactly one scan and routes to `/scans/{run.id}`.

- [ ] **Step 1: Failing tests.** ScansList dom test: a row for `persona: 'remote'` renders a Tag with text `remote`. Resume page test: after a successful upload, `startSearch` has NOT been called; clicking "Scan remote roles" calls `startSearch({ persona: "remote" })` exactly once and pushes `/scans/<run.id>`.

- [ ] **Step 2: Implement `resume/page.tsx`.** Delete `startSearches` and its `Promise.allSettled` block + the module doc-comment's dual-persona sentence. Replace with:

```tsx
const [justUploaded, setJustUploaded] = React.useState(false);
const [scanLaunching, setScanLaunching] = React.useState<"remote" | "local" | null>(null);

async function handleScan(persona: "remote" | "local") {
  setScanLaunching(persona);
  setSearchError(undefined);
  try {
    const run = await startSearch({ persona });
    router.push(`/scans/${run.id}`);
  } catch (err) {
    setSearchError(err instanceof Error ? err.message : "Scan failed to start.");
    setScanLaunching(null);
  }
}
```

In `handleFile`: set `setStatus("parsing")` immediately after dispatching the upload promise is impossible to split from upload — instead call `setStatus("parsing")` right before the `await uploadResume(...)` line (the LLM extraction dominates the wall time; the kit renders "Parsing résumé…"). On success: `setStatus("done"); setResume(uploaded); setJustUploaded(true);` — **no scan call**.

In the render, when `resume && justUploaded`, show a prompt Card above `ResumeView` (kit primitives, tokens only):

```tsx
<Card>
  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
    <div>
      <div style={{ font: "var(--type-h3)", color: "var(--text-strong)" }}>Résumé ready</div>
      <div style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>
        Review it below, then scan for matching roles when you're ready. A scan costs 10 credits.
      </div>
    </div>
    <div style={{ display: "flex", gap: 8 }}>
      <Button variant="primary" disabled={scanLaunching !== null} onClick={() => void handleScan("remote")}>
        Scan remote roles
      </Button>
      <Button variant="secondary" disabled={scanLaunching !== null} onClick={() => void handleScan("local")}>
        Scan local roles
      </Button>
      <Button variant="ghost" onClick={() => setJustUploaded(false)}>Not now</Button>
    </div>
  </div>
</Card>
```

(If the Button variants differ from the kit's actual union, match the kit — read `Button.tsx` first. Keep the existing `searchError` banner, now retrying the single chosen persona.)

- [ ] **Step 3: Kit copy.** `ResumeUpload.tsx:112`: `"Parsing résumé…"` → `"Parsing résumé — usually 10–20 seconds…"`. `ScansList.tsx`: import `Tag`; in the row header flex, next to `resumeName`: `<Tag tone="neutral">{run.persona}</Tag>` (mirror `ScanReplay.tsx:78`).

- [ ] **Step 4: Update `e2e/resume-scan-feed.spec.ts`.** The spec pasted a résumé and waited for the auto-scan; insert the explicit step after paste: click `Scan remote roles` (or whichever persona its fixtures serve), then keep its existing `/scans` assertions — but note the page now navigates to `/scans/{id}` directly; adjust the intermediate list-page assertion accordingly (read the spec, keep its fixture waits).

- [ ] **Step 5: Run + commit** — `npx vitest run src/caliber-ui/compositions/Scans "src/app/(app)/resume"` → PASS (e2e is env-gated; run it only if the harness is configured locally). `git commit -m "feat(resume): review-then-scan flow, single persona kickoff, persona labels"`

---

### Task 9: Credits UI — store, chip, insufficient-credits dialog

**Files:**
- Create: `src/features/credits/client.ts`, `src/features/credits/creditsStore.ts`
- Test: `src/features/credits/creditsStore.test.ts`
- Create: `src/caliber-ui/compositions/Shell/InsufficientCreditsDialog.tsx`
- Modify: `src/app/AppShell.tsx` (mount chip + dialog)
- Modify feature clients (post-success refresh): `src/features/search/client.ts` (startSearch), `src/features/url-check/client.ts` (startCheck), `src/features/feed/client.ts` (evaluateJob), `src/features/tailor/client.ts` (startCorrelate, startTailor), `src/features/resume/client.ts` (uploadResume), `src/features/apply/client.ts` (draftAnswers/its answer call)
- Modify 402 catch sites: `src/features/url-check/checksStore.ts` (submit/submitEvaluate catches), `src/app/(app)/resume/page.tsx` (handleScan), `src/app/(app)/scans/page.tsx` (handleScanNow), `src/app/(app)/feed/page.tsx` (scan button), `src/app/(app)/jobs/[id]/tailor/page.tsx`, the apply page's answers call site

**Interfaces:**
- Consumes: `GET /api/credits` (Task 5); `ApiError` (`status === 402` / `code === "INSUFFICIENT_CREDITS"`, `details: { feature, required, balance }`).
- Produces:

```ts
// creditsStore.ts (module singleton + useSyncExternalStore — mirror checksStore.ts)
export interface CreditDenial { feature: string; required: number; balance: number }
export function refreshCredits(): void;               // fire-and-forget GET /api/credits → state
export function showDenial(d: CreditDenial): void;
export function dismissDenial(): void;
export function useCredits(): { balance: number | null; plan: "standard" | "unlimited" | null; denial: CreditDenial | null };
```

- [ ] **Step 1: Failing store tests** (jsdom, mock `getCredits`): refresh populates balance/plan and notifies subscribers; showDenial/dismissDenial round-trip; a failed refresh leaves prior state (no fallback zero — `null` until first success).

- [ ] **Step 2: Implement.** `client.ts`: `getCredits(): Promise<CreditsResponse>` via `requestJson("/api/credits", undefined, CreditsResponse)`. `creditsStore.ts`: module state `{ balance: number | null, plan: … | null, denial: … | null }`, `listeners: Set`, snapshot-cache pattern copied from `checksStore.ts:187-196` (same identity-stability comment applies).

**Chip** — small client component inside `AppShell.tsx` (AppShell is already `"use client"`): on mount `refreshCredits()`; render nothing while `balance === null` or `plan === "unlimited"`; else a kit `Chip` reading `⬡ {balance} credits`, absolutely positioned top-right of `<main>` (`position: "fixed", top: 16, right: 24, zIndex` consistent with CheckDock's — read CheckDock's z-index and sit one below).

**Dialog** — `InsufficientCreditsDialog.tsx`: fixed full-viewport overlay (`background: color-mix(in srgb, var(--text-strong) 35%, transparent)`), centered `Card`, copy per spec §4.4 with the live numbers:

```tsx
const FEATURE_LABEL: Record<string, string> = {
  scan: "Scans", evaluate: "Checks", tailor: "Tailoring", resume: "Résumé extraction", answers: "Answers",
};
// "<Feature> cost(s) N credits — you have M."
// Body: "Get 150 credits for $5 — message the operator to top up; credits never expire."
// Primary Button: "Got it" (dismissDenial). No payment link yet (manual per spec §2.7).
```

Mount both in `AppShell` next to `<CheckDock />`. Dialog renders only when `denial !== null`.

**Refresh hooks:** in each listed feature-client function, after the awaited `requestJson` resolves successfully, call `refreshCredits()` (import from `@/features/credits/creditsStore`). One line each; debits are admission-time so the new balance is already visible.

**402 catches:** at each listed catch site, add before the generic branch:

```ts
if (err instanceof ApiError && err.code === "INSUFFICIENT_CREDITS") {
  const d = err.details as { feature: string; required: number; balance: number };
  showDenial(d);
  // then the site's existing failure handling (banner copy can stay generic)
}
```

In `checksStore.submit`'s `.catch`, keep the run's `START_FAILED` terminal state but call `showDenial` first when the error matches.

- [ ] **Step 3: Run + commit** — `npx vitest run src/features/credits src/features/url-check/checksStore.test.ts src/features/http.test.ts "src/app/(app)"` → PASS. `git commit -m "feat(credits): balance chip, empty-wallet dialog, refresh hooks"`

---

### Task 10: Admin — balance/plan columns, plan toggle, grants

**Files:**
- Modify: `src/types/index.ts` (`AdminUser` +`balance: z.number().int()` +`plan: z.enum(["standard","unlimited"])`; new `AdminPlanPatch = z.object({ plan: z.enum(["standard","unlimited"]) })`; new `AdminGrantRequest = z.object({ delta: z.number().int().refine((n) => n !== 0) })`)
- Modify: `src/server/persistence/repos/users.ts` (`listWithCounts` ~line 71 — join ledger sum + plan; add `updatePlan(id, plan)`)
- Create: `src/app/api/admin/users/[id]/route.ts` (PATCH — plan)
- Create: `src/app/api/admin/users/[id]/credits/route.ts` (POST — grant)
- Modify: `src/app/api/admin/users/route.ts` (surface new fields)
- Modify: `src/caliber-ui/compositions/Admin/AdminUsersTable.tsx` + `src/app/(app)/admin/page.tsx`
- Modify: `src/features/admin/client.ts` (patchUserPlan, grantCredits)
- Modify: `src/contract/registry.ts` + regen
- Tests: users repo test, two new route tests, AdminUsersTable dom test

**Interfaces:**
- Consumes: `grant(userId, delta, "admin")` from Task 4; `requireAdmin`.
- Produces: `PATCH /api/admin/users/:id` body `{ plan }` → 200 updated AdminUser; `POST /api/admin/users/:id/credits` body `{ delta }` → 200 `{ balance }`; both 403 for non-admins (mirror the existing admin route's guard/catch).

- [ ] **Step 1: Failing tests:** repo — `listWithCounts` rows carry `plan` and `balance` (user with +30/−10 rows → 20; user with none → 0, via `COALESCE`d left join, **not** an N+1 per-user query). Routes — non-admin 403; PATCH flips plan and the user's next `assertAndDebit` bypasses (integration assertion via the credits module); POST `{ delta: 150 }` writes one `admin` ledger row and returns the new balance; `{ delta: 0 }` 422s.

- [ ] **Step 2: Implement.** `listWithCounts`: extend the existing aggregate query with `plan: users.plan` and a `leftJoin` on a grouped ledger-sum subquery (`sql<number>\`COALESCE(${sum}, 0)\``). `updatePlan`: single `db.update(users).set({ plan }).where(eq(users.id, id)).returning()`, throw if no row. Routes follow the existing admin route's `requireAdmin` + `errorResponse` idiom. UI: two new columns (balance number, plan `Chip`), row actions: `+150 (pack)` Button → `grantCredits(id, 150)`, small `Input` + apply for arbitrary ±delta, plan toggle Button. Refetch the list after each action (the page already loads via `features/admin/client`).

- [ ] **Step 3: Contract regen + run + commit** — `npm run contract && npx vitest run src/server/persistence/repos src/app/api/admin src/caliber-ui/compositions/Admin` → PASS. `git commit -m "feat(admin): wallet columns, plan toggle, credit grants"`

---### Task 11: e2e + docs + deploy hygiene

**Files:**
- Modify: `e2e/authSetup.ts` (invite code in `E2E_USER` register payload), `playwright.config.ts` (webServer env — add `CALIBER_INVITE_CODE`; if no env block exists on webServer, add one), any other spec registering users (grep `"/api/auth/register"` under `e2e/`)
- Create: `e2e/credits.spec.ts`
- Modify: `DEPLOY.md` (tripwire section, lines ~71-75), `.env.production.example` (shell append only)
- Test: `npm run check`

**Interfaces:** consumes everything above; produces the updated operator runbook.

- [ ] **Step 1: e2e harness.** `authSetup.ts`: add `inviteCode: "e2e-invite"` to `E2E_USER`'s register data (login path unaffected). `playwright.config.ts` webServer env: `CALIBER_INVITE_CODE: "e2e-invite"`.

- [ ] **Step 2: `e2e/credits.spec.ts`** (deterministic, no LLM): register a **fresh** unique-email user (with invite code) → the header chip shows `⬡ 30 credits`; via the API context, drain the wallet with an admin grant of `-30` (admin login from seed creds the harness already uses; `POST /api/admin/users/{id}/credits { delta: -30 }`) → reload → chip shows 0; click a scan button → the insufficient-credits dialog appears with "Scans cost 10 credits — you have 0."

**Deliberate substitution for spec §5's "golden path consumes 26 credits" e2e:** a real golden-path run is LLM-bound (env-gated, minutes, nondeterministic cost of flakes). The 26-total is instead pinned piecewise at unit/route level (extract 3 + scan 10 + evaluate 5 + tailor-flow exactly 8 — Tasks 6–7 tests), and the e2e above covers the wire-to-UI 402 behavior deterministically. If the operator wants the full-fat run, it belongs in the env-gated `smoke:real` tier, not CI.

- [ ] **Step 3: Docs.** `DEPLOY.md`: replace the four tripwire bullets with the closed state — invite gate (env `CALIBER_INVITE_CODE`, rotate to invalidate), 30-day sliding session TTL, per-user spend bounded by prepaid credits, and reframe `CALIBER_DAILY_LLM_USD=5` as the operator's wallet circuit-breaker (runaway-bug protection, not fairness). Append the env example key: `printf '\n# Registration invite gate (membership spec) — rotate to invalidate\nCALIBER_INVITE_CODE=\n' >> .env.production.example`. Add an operator note in DEPLOY.md: set the real code in `/opt/caliber/.env.production` on the box before the next deploy.

- [ ] **Step 4: Full gate + commit** — `npm run check` (typecheck + all tests + contract check + build) → green. `git commit -m "feat(credits): e2e coverage + deploy runbook for the closed tripwires"`

---

## Deferred (spec §7 — do NOT build)

Stripe/processors; subscriptions; credit expiry; monthly grant scheduler; per-user USD metering; Redis rate limiting; email verification; CAPTCHA; refund mechanics; purchase-history page; depth-gating; per-invite-code DB rows.

## Execution notes

- Task order is the rollout order (spec §6); Tasks 1–2 ship value even if the rest pauses.
- Tasks 6 and 7 are parallel-safe (disjoint files) once 4–5 land; everything else is sequential.
- After merge, production needs: migration applied, `CALIBER_INVITE_CODE` set on the box, then the standard push-to-box deploy (`/box` skill).
