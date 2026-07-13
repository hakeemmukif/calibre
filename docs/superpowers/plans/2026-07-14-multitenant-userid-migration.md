# Multi-Tenant user_id Migration + Write-Path Scoping (Step 2 of 9)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a `user_id` column to all 9 user-owned tables, backfill every existing row to the bootstrap admin, make it `NOT NULL`, convert the affected unique constraints to per-user shape, and update every write path (repo insert methods, seeds, test fixtures) so the full suite stays green with all data owned by the one admin. Multi-user *read* isolation is Step 3.

**Architecture:** One hand-finished Drizzle migration (`0009`) following the repo's `add-nullable → UPDATE-backfill → SET NOT NULL` DML precedent (`drizzle/0001_abnormal_blob.sql`). The migration first inserts the fixed-UUID bootstrap admin (placeholder creds; `seed.ts` sets real creds later) so the backfill FK has a target. `sources` stays global (no `user_id`). After the migration, every table row belongs to `BOOTSTRAP_ADMIN_ID`, so reads remain correct single-user; only write signatures change this step.

**Tech Stack:** Next.js 15 · TypeScript · Zod · Drizzle + Postgres (PGlite in tests). Builds on Step 1 (auth core: `users`/`sessions`, `BOOTSTRAP_ADMIN_ID` in `src/server/auth/ids.ts`, seed admin).

## Global Constraints

- **Migration must replay clean on empty PGlite** — `test-db.ts` replays every `drizzle/*.sql` into a fresh empty PGlite on every repo test. On an empty DB: admin INSERT succeeds, all backfill UPDATEs are no-ops (0 rows), `SET NOT NULL` succeeds on empty tables, constraint conversions succeed. Verify by running the suite.
- **Fail loud, no fallbacks.** `user_id` is `NOT NULL` with no column default; every insert supplies it explicitly. No repo defaults a missing `user_id` to the admin at runtime — that is the migration's one-time job, not a code fallback.
- **`BOOTSTRAP_ADMIN_ID` = `00000000-0000-4000-8000-000000000001`** (from `src/server/auth/ids.ts`) — the migration's admin INSERT and all backfill UPDATEs use this literal. It matches `seed.ts`'s `seedAdmin` (which `onConflictDoUpdate`s the same id with real creds).
- **`sources` stays global** — no `user_id`.
- **This migration is tenancy-only** — do NOT convert `timestamp` → `timestamptz` here (deferred to a separate later migration, per operator decision 2026-07-14).
- **drizzle-kit generates DDL; you hand-finish the DML + ordering.** Run `db:generate` to get the DDL + snapshot, then hand-edit only the `.sql` body to the safe sequence. The `_journal.json` + `0009_snapshot.json` from generate stay as-is (they reflect the final schema).
- **Suite stays green at the end of the step.** Baseline entering Step 2: 820 tests.

## The 9 user-owned tables (get `user_id`)
`profile, resumes, search_runs, jobs, job_scores, application_answers, tailored_resumes, url_checks, applications`. (`sources`, `users`, `sessions` do NOT.)

## Constraint conversions (in the migration + schema.ts)
- `jobs`: drop the global `UNIQUE(dedupe_key)`, add `UNIQUE(user_id, dedupe_key)`.
- `profile`: add `UNIQUE(user_id)` (each user has one profile). Keep the existing `id` text PK.
- `resumes`: add partial unique index `UNIQUE(user_id) WHERE is_active` (each user has ≤1 active résumé). PGlite supports partial unique indexes — the existing `url_checks_queued_idx` partial index proves it.
- `applications`: `UNIQUE(job_id)` stays (valid once jobs are per-user).
- `job_scores`: existing `UNIQUE(job_id, resume_id, policy_version)` stays; just add `user_id`.

---

## File Structure
- `src/server/persistence/schema.ts` — MODIFY: add `userId` to the 9 tables; change jobs/profile/resumes constraints.
- `drizzle/0009_*.sql` + `drizzle/meta/*` — CREATE via `db:generate`, then hand-finish the `.sql`.
- `src/server/persistence/seed.ts` — MODIFY: `seedProfile` supplies `user_id = BOOTSTRAP_ADMIN_ID`.
- `src/server/persistence/repos/*.ts` (the 9 owning repos) — MODIFY: every `insert(...).values({...})` gains `userId`; insert method signatures take a `userId`.
- `src/server/persistence/repos/*.test.ts` + `repos/__fixtures__/*` — MODIFY: supply a `userId` (use `BOOTSTRAP_ADMIN_ID` or a locally-created user) in every insert.
- `src/server/persistence/repos/users.test.ts` — MODIFY: `usersRepo.list()` test accounts for the migration-seeded admin.
- `seed.test.ts` — MODIFY: `seedProfile` test supplies/expects `user_id`.

---

## Task 1: schema.ts changes + the hand-finished migration

**Files:** `src/server/persistence/schema.ts`; `drizzle/0009_*.sql`, `drizzle/meta/*` (generated + hand-finished); test `src/server/persistence/migration-0009.test.ts`.

**Interfaces produced:** every owning table's `$inferInsert` now includes `userId: string`. New constraints: `jobs UNIQUE(user_id, dedupe_key)`, `profile UNIQUE(user_id)`, `resumes` partial unique `(user_id) WHERE is_active`.

- [ ] **Step 1: Edit `schema.ts`** — add to each of the 9 tables (place consistently, e.g. right after `id`):

```ts
userId: uuid("user_id").notNull().references(() => users.id),
```

  For `jobs`: remove `.unique()` from the `dedupeKey` column definition, and add a table-level constraint in the table's second-arg array:
```ts
(table) => [unique("jobs_user_id_dedupe_key_unique").on(table.userId, table.dedupeKey)],
```
  For `profile`: add a table-level `unique("profile_user_id_unique").on(table.userId)` (convert `profile` to the two-arg `pgTable(..., (table) => [...])` form).
  For `resumes`: add a partial unique index in the second arg:
```ts
(table) => [uniqueIndex("resumes_user_id_active_unique").on(table.userId).where(sql`${table.isActive}`)],
```
  `import { uniqueIndex } from "drizzle-orm/pg-core"` and ensure `sql` is imported (it already is). For `job_scores`/`applications`, keep their existing constraint arrays and just add the `userId` column.

- [ ] **Step 2: Generate the raw migration**

```bash
DATABASE_URL="postgres://x" npm run db:generate
```
This writes `drizzle/0009_*.sql` (DDL only) + `drizzle/meta/0009_snapshot.json` + updates `_journal.json`. drizzle-kit will emit `ADD COLUMN "user_id" uuid NOT NULL` and the FK/constraint DDL. **Do NOT run this as-is** — the `NOT NULL` add fails on any populated table and the FK has no target row.

- [ ] **Step 3: Hand-finish `drizzle/0009_*.sql`** to this safe sequence (statements separated by `--> statement-breakpoint`, per repo convention). Keep drizzle's exact generated constraint/FK names — copy them from the generated file; do not invent names. Prepend the admin INSERT, and for EACH of the 9 tables split the generated `ADD COLUMN ... NOT NULL` into add-nullable → backfill → (FK) → SET NOT NULL:

```sql
INSERT INTO "users" ("id","email","password_hash","role")
VALUES ('00000000-0000-4000-8000-000000000001','admin@bootstrap.local','!','admin')
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "profile" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
UPDATE "profile" SET "user_id" = '00000000-0000-4000-8000-000000000001' WHERE "user_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "profile" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
-- ...then the FK + UNIQUE(user_id) that drizzle generated for profile...
```
  Repeat the add-nullable → UPDATE → SET NOT NULL triplet for all 9 tables. Place each table's drizzle-generated FK constraint (`..._user_id_users_id_fk`) AFTER its backfill (target row now exists) and its NOT NULL. Place the jobs dedupe drop/add and the resumes partial index after their backfills. The placeholder password hash `'!'` can never verify (fail-safe: the admin cannot log in until `seed.ts` sets the real hash).

- [ ] **Step 4: Write the replay + constraint test** `migration-0009.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./test-db";
import { users, profile, jobs, resumes } from "./schema";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

const ADMIN = BOOTSTRAP_ADMIN_ID;

describe("0009 user_id migration (empty-DB replay)", () => {
  it("seeds the bootstrap admin so the backfill FK has a target", async () => {
    const db = await createTestDb();
    const [a] = await db.select().from(users).where(eq(users.id, ADMIN));
    expect(a?.role).toBe("admin");
  });

  it("profile enforces UNIQUE(user_id)", async () => {
    const db = await createTestDb();
    await db.insert(profile).values({ id: "p1", userId: ADMIN, baseCountry: "MY", relocation: "stay" });
    await expect(
      db.insert(profile).values({ id: "p2", userId: ADMIN, baseCountry: "MY", relocation: "stay" }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("resumes allows one active per user, rejects a second (partial unique)", async () => {
    const db = await createTestDb();
    const base = { userId: ADMIN, rawText: "x", structured: {} as never, sourceKind: "paste" as const };
    await db.insert(resumes).values({ ...base, isActive: true });
    await db.insert(resumes).values({ ...base, isActive: false }); // inactive is fine
    await expect(db.insert(resumes).values({ ...base, isActive: true }))
      .rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("jobs dedupe is per-user: same dedupe_key under one user conflicts", async () => {
    const db = await createTestDb();
    // (construct a minimal valid jobs row per schema.ts; two inserts with the
    //  same userId+dedupeKey must reject with 23505 — copy required columns
    //  from an existing jobs.test.ts fixture and add userId)
  });
});
```
  Fill the jobs test body from an existing `jobs.test.ts` fixture (add `userId`). Assert `.cause.code === "23505"` (the drizzle-wrapped shape confirmed in Step 1's users-race fix).

- [ ] **Step 5: Run the focused test** — `npm test -- src/server/persistence/migration-0009.test.ts`. Expect PASS (proves the hand-finished SQL replays + constraints fire on empty PGlite). NOTE: other repo tests are RED until Tasks 2–4 add `user_id` to their inserts — that's expected this task.

- [ ] **Step 6: Commit** — `git add src/server/persistence/schema.ts drizzle/ src/server/persistence/migration-0009.test.ts && git commit -m "feat(tenancy): user_id migration on 9 tables + per-user constraints"`

---

## Task 2: seed.ts write path

**Files:** `src/server/persistence/seed.ts`, `seed.test.ts`.

- [ ] **Step 1** Update `seedProfile` so `profileSeed` includes `userId: BOOTSTRAP_ADMIN_ID` (import it). The seeded 'default' profile now belongs to the admin. `seedSources` is unchanged (global).
- [ ] **Step 2** Update the `seedProfile` test in `seed.test.ts` to supply/expect `user_id`. Keep the `seedSources` (14 rows) and `seedAdmin` tests intact. Note ordering in the module-main guard: `seedAdmin` must run before `seedProfile` (profile FK → users), so confirm the guard seeds admin first.
- [ ] **Step 3** Run `npm test -- src/server/persistence/seed.test.ts`; commit `feat(tenancy): seed profile under the bootstrap admin`.

---

## Tasks 3a–3c: repo write-path scoping (grouped; one implementer each)

For every owning repo, apply this **uniform transformation** and keep each repo's existing tests green by supplying a `userId`:
- Every method that INSERTs (`create`, `upsert*`, `add*`, `record*`, etc.) gains a `userId: string` (add it as the first parameter of the method's input object, or a leading arg — match the repo's existing arg style) and includes `userId` in the `.values({...})`.
- Do NOT add `userId` filtering to reads/updates yet (that's Step 3) — only make writes supply `userId` so `NOT NULL` is satisfied.
- Update each repo's `*.test.ts` and any `__fixtures__` so every insert supplies a `userId` — use `BOOTSTRAP_ADMIN_ID` (import from `@/server/auth/ids`) unless the test already creates its own user.
- Preserve all existing assertions/behavior otherwise.

Worked example (resumes): `create(input)` → `create(input & { userId })`, `db.insert(resumes).values({ ...cols, userId })`; in `resumes.test.ts`, every `db.insert(resumes).values({...})` / `repo.create({...})` gains `userId: BOOTSTRAP_ADMIN_ID`.

- [ ] **Task 3a** — `profile.ts`, `resumes.ts`, `searchRuns.ts` (+ their tests/fixtures). Run their focused tests green, commit.
- [ ] **Task 3b** — `jobs.ts`, `jobScores.ts`, `urlChecks.ts` (+ tests/fixtures). `jobs.upsertByDedupeKey` must set `userId` on insert; note the composite-unique now keys on `(user_id, dedupe_key)`. Run focused tests green, commit.
- [ ] **Task 3c** — `applications.ts`, `applicationAnswers.ts`, `tailoredResumes.ts` (+ tests/fixtures). Run focused tests green, commit.

(Each 3x task ends with its repos' tests green and a commit. They touch disjoint files → no cross-task conflict, but run sequentially per subagent-driven rules.)

---

## Task 4: fix count-sensitive Step-1 test + full green

**Files:** `src/server/persistence/repos/users.test.ts`.

- [ ] **Step 1** The migration now pre-seeds the bootstrap admin into `users`, so `createTestDb()` starts with 1 user. Update the `usersRepo.list()` test: instead of `expect(list.length).toBe(2)`, assert the two created users are present alongside the admin — e.g. filter to the created emails, or assert `length` is 3 and includes the admin id. Keep the test meaningful (still verifies both created users are returned).
- [ ] **Step 2** Grep for any OTHER test asserting an exact `users`/`profile`/table row count that the pre-seeded admin or the now-required `user_id` would shift; fix each.
- [ ] **Step 3** Run the FULL suite — `npm test`. Expect all green (820 baseline + new migration/isolation tests; count may differ). Then `npm run typecheck` + `npm run contract:check` (contract unaffected — no wire-shape change this step, but confirm exit 0). Commit any fixes.

---

## Task 5: live backfill acceptance (throwaway Postgres)

The empty-PGlite replay proves the migration is syntactically safe and constraints fire, but NOT that backfill assigns *existing* rows to the admin (test DBs start empty). Verify on real Postgres with an incremental migrate.

- [ ] **Step 1** Create a throwaway DB; migrate only up to `0008`; insert a couple of pre-tenancy rows (a `sources` row + a `jobs` row + a `profile` row with the OLD shape — no `user_id`); then run `db:migrate` to apply `0009`; assert those rows now have `user_id = BOOTSTRAP_ADMIN_ID` and the admin row exists. Then drop the DB. (Mirror the Step-1 smoke: `psql` create → inline `DATABASE_URL` → `db:migrate` → `psql` asserts → drop. Do NOT touch the real `caliber` DB.)
- [ ] **Step 2** Record the transcript in the report. This is the Step-2 acceptance gate.

---

## Self-Review
- 9 tables get `user_id NOT NULL` backfilled to the fixed admin; `sources` stays global. ✓ (Task 1)
- Constraint conversions: jobs composite, profile per-user, resumes partial-active. ✓ (Task 1)
- Migration replay-safe on empty PGlite + admin pre-seeded for FK. ✓ (Task 1, Task 4 full green)
- Write paths (seeds, all 9 repos, fixtures) supply `user_id` → suite green. ✓ (Tasks 2, 3a–c, 4)
- Real-data backfill verified on Postgres. ✓ (Task 5)
- **Deferred to Step 3 (correctly):** required-`userId` read params, per-user filtering, `resumesRepo.getActive(userId)`, `profileRepo` dropping `SINGLETON_ID`, route `requireUser()` threading, cross-user isolation tests, the search-run 409 mutex/feed stats going per-user.
- **Deferred (separate migration):** `timestamp → timestamptz` conversion.
- **Not re-litigated:** admin-in-migration insert + test-count adjustment (operator-decided 2026-07-14); tenancy-only migration scope (operator-decided).
