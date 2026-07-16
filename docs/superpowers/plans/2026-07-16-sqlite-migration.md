# SQLite (libsql) Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Caliber's PostgreSQL/PGlite persistence with SQLite via libsql as the single dialect, with zero change to entity shapes, API contracts, repo signatures, or business logic.

**Architecture:** Retype the Drizzle schema `pg-core → sqlite-core`, swap the runtime driver (`postgres-js → libsql`) and the test harness (`PGlite → in-memory libsql`), port ~8 hand-written raw-SQL fragments, and regenerate a single clean migration baseline. The existing 62 DB-backed test files are the correctness oracle: a task is done when its target tests pass against SQLite.

**Tech Stack:** Drizzle ORM 0.45.2 (`drizzle-orm/libsql`, `drizzle-orm/sqlite-core`), `@libsql/client`, drizzle-kit 0.31.10 (`dialect: sqlite`), Node 22, Vitest.

**Source spec:** `docs/superpowers/specs/2026-07-16-sqlite-migration-design.md` (decisions D1–D7 are binding).

## Global Constraints

- **No contract drift.** `src/types` shapes, API route response shapes, and repo method signatures stay byte-identical. Only the dialect underneath moves.
- **Fail loud.** `getDb()` throws when `DATABASE_URL` is unset. No fallback defaults anywhere (project rule).
- **D1 timestamps:** `integer({ mode: "timestamp_ms" })`, repos read/write JS `Date`, drop `withTimezone`.
- **D2 primary keys:** `text().primaryKey().$defaultFn(() => crypto.randomUUID())` — keep UUIDv4 text format.
- **D3 numerics:** `real()` for `score` / `cost_usd` / `ats_score`.
- **D7 json:** `text({ mode: "json" }).$type<T>()`.
- **`PRAGMA foreign_keys=ON` on every connection** (real + test) — cascades/set-null silently no-op otherwise.
- **Surgical diffs**, match existing style, no speculative abstractions (project rule).
- **Execute on branch `feat/sqlite-migration`.** The working tree has pre-existing unrelated edits (`JobRow.dom.test.tsx`, `eligibility.tsx`, some spec files) — stash or leave them; do not fold them into migration commits.

---

## Wave structure

| Wave | Tasks | Parallelism | Model / effort |
|---|---|---|---|
| **1 — Foundation** | T1 deps · T2 schema · T3 plumbing (driver+test-db+Db type+config+baseline) | Sequential (T1→T2→T3) | `executor` (Sonnet), **high** effort — load-bearing, interdependent |
| **2 — Repo fragment ports** | T4 urlChecks · T5 jobs · T6 searchRuns · T7 misc-now | **Parallel** (4 subagents, disjoint files) | T4/T5 `executor` **high** (real rewrites); T6 `executor` **medium**; T7 `executor` **low** |
| **3 — Fallout + gate** | T8 smoke+docs · T9 full verification | Sequential | T8 `executor` **low**; T9 `executor` **medium** |
| **Review** | R1 Fable diff review | After Wave 3 | `deep-thinker` (Fable), **high** effort |

Wave 2 may only start once Wave 1's exit gate is green (schema + plumbing round-trip). Within Wave 2, the four tasks touch disjoint files (`urlChecks.ts`+its test, `jobs.ts`, `searchRuns.ts`, `profile.ts`/`applications.ts`/`sessions.ts`) and disjoint test files — safe to run concurrently.

---

## WAVE 1 — Foundation

### Task 1: Swap dependencies

**Goal:** libsql client in, Postgres/PGlite out.

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Remove Postgres deps, add libsql**

Run:
```bash
npm uninstall postgres @electric-sql/pglite
npm install @libsql/client
```

- [ ] **Step 2: Verify install**

Run: `node -p "require('./node_modules/@libsql/client/package.json').version"`
Expected: prints a version (e.g. `0.x.y`), no error.

- [ ] **Step 3: Confirm Postgres deps gone**

Run: `grep -E '"postgres"|pglite' package.json || echo CLEAN`
Expected: `CLEAN`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(db): swap postgres/pglite deps for @libsql/client"
```

---

### Task 2: Retype the schema to sqlite-core

**Goal:** `src/server/persistence/schema.ts` compiles as sqlite-core with every column mapped per D1/D2/D3/D7.

**Files:**
- Modify: `src/server/persistence/schema.ts`

**Interfaces:**
- Produces: the same 13 exported table objects (`sources`, `profile`, `resumes`, `searchRuns`, `jobs`, `jobScores`, `applicationAnswers`, `tailoredResumes`, `correlationReports`, `urlChecks`, `applications`, `users`, `sessions`) with identical column names and TS `$type` shapes. `$inferSelect`/`$inferInsert` for every table must keep the same field names and TS types (Date, number, boolean, the json `$type<T>()`).

- [ ] **Step 1: Replace the imports**

Change the pg-core import block to sqlite-core. The `sql` import from `drizzle-orm` stays.

```typescript
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
```

(No `boolean`, `jsonb`, `numeric`, `timestamp`, `uuid`, `pgTable` — those become the mappings below.)

- [ ] **Step 2: Update the header comment**

Replace the "Drizzle pg-core schema … Postgres everywhere — see db.ts / test-db.ts" comment with a sqlite-core note referencing this migration and `db.ts` (libsql) / `test-db.ts` (in-memory libsql).

- [ ] **Step 3: Convert every table per the D-map**

Apply mechanically across all 13 tables. Representative conversions (follow this exact pattern for the rest — the full column inventory is in the spec §2 table):

`sources` (natural-key PK, json, timestamp default):
```typescript
export const sources = sqliteTable("sources", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["ats", "board", "manual"] }).notNull(),
  persona: text("persona", { enum: ["remote", "local", "both"] }).notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  config: text("config", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});
```

`resumes` (uuid PK, json, real, boolean, partial unique index):
```typescript
export const resumes = sqliteTable(
  "resumes",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull().references(() => users.id),
    rawText: text("raw_text").notNull(),
    structured: text("structured", { mode: "json" }).$type<ResumeStore>().notNull(),
    originalPath: text("original_path"),
    label: text("label"),
    sourceKind: text("source_kind", { enum: ["pdf", "docx", "paste"] }).notNull(),
    atsScore: real("ats_score"),
    isActive: integer("is_active", { mode: "boolean" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("resumes_user_id_active_unique").on(table.userId).where(sql`${table.isActive}`)],
);
```

`searchRuns.results` (json array with a default):
```typescript
results: text("results", { mode: "json" }).$type<ScanResult[]>().notNull().$defaultFn(() => []),
```

`users`/`sessions` — drop `withTimezone`, keep `.unique()` and `onDelete: "cascade"`:
```typescript
createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
```

Conversion rules for the remaining columns:
- every `uuid("x")` non-PK FK column → `text("x")` (drop `.defaultRandom()`; PKs get `.$defaultFn(() => crypto.randomUUID())`, FKs get nothing).
- every `jsonb("x").$type<T>()` → `text("x", { mode: "json" }).$type<T>()` (keep `.notNull()` / nullability exactly).
- every `timestamp("x")` → `integer("x", { mode: "timestamp_ms" })`; `.defaultNow()` → `.$defaultFn(() => new Date())`; keep nullability.
- every `numeric("x", …)` → `real("x")` (drop precision/scale/mode; keep `.notNull()` where present).
- every `boolean("x")` → `integer("x", { mode: "boolean" })`.
- `integer("x")` (stage, attempts) → unchanged; keep `.default(0)` on `attempts`.
- `text(..., { enum })`, `.references(...)`, `.unique()`, `unique(...)`, `index(...).where(...)`, `onDelete` → unchanged.

- [ ] **Step 4: Typecheck the schema in isolation**

Run: `npx tsc --noEmit 2>&1 | grep -E 'persistence/schema.ts' || echo SCHEMA-CLEAN`
Expected: `SCHEMA-CLEAN` (schema.ts itself has no type errors; `db.ts`/`test-db.ts`/`jobs.ts` errors are expected here and fixed in T3/Wave 2).

- [ ] **Step 5: Commit**

```bash
git add src/server/persistence/schema.ts
git commit -m "refactor(db): retype schema pg-core -> sqlite-core"
```

---

### Task 3: Driver, test harness, Db type, config, migration baseline

**Goal:** libsql plumbing end-to-end — real client, in-memory test client, unified `Db` type, sqlite drizzle config, one regenerated migration — proven by a round-trip on a raw-SQL-free table.

**Files:**
- Modify: `src/server/persistence/db.ts`
- Modify: `src/server/persistence/test-db.ts`
- Modify: `src/server/persistence/repos/db.ts`
- Modify: `drizzle.config.ts`
- Delete: `drizzle/*.sql`, `drizzle/meta/`
- Create: `drizzle/0000_*.sql` (generated)
- Create (temporary): `src/server/persistence/plumbing.smoke.test.ts` (round-trip proof; delete in Step 10)

**Interfaces:**
- Produces: `getDb(): LibSQLDatabase<typeof schema>` (same name/singleton contract as today). `createTestDb(): Promise<Db>` (same signature). `Db = LibSQLDatabase<typeof schema>`.

- [ ] **Step 1: Rewrite `db.ts` (libsql client + pragmas)**

```typescript
// libsql singleton. Every server/* module gets its Drizzle client from here —
// nothing outside src/server/persistence may import @libsql/client directly.
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema";

let db: LibSQLDatabase<typeof schema> | undefined;

export function getDb(): LibSQLDatabase<typeof schema> {
  if (db) return db;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN });
  applyPragmas(client, url);
  db = drizzle(client, { schema });
  return db;
}

function applyPragmas(client: Client, url: string): void {
  // FK enforcement is OFF by default in SQLite; our cascades/set-null need it.
  void client.execute("PRAGMA foreign_keys = ON");
  // WAL + busy_timeout only apply to a local file DB; remote libsql handles
  // concurrency server-side.
  if (url.startsWith("file:")) {
    void client.execute("PRAGMA journal_mode = WAL");
    void client.execute("PRAGMA busy_timeout = 5000");
  }
}
```

- [ ] **Step 2: Rewrite `test-db.ts` (in-memory libsql + migration replay)**

```typescript
// In-memory libsql test harness. Every repo test creates its own isolated
// instance via createTestDb() and applies the committed drizzle/*.sql migrations
// — same SQL that runs against a real file DB via `db:migrate`.
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "./schema";
import type { Db } from "./repos/db";

const migrationsDir = join(__dirname, "../../../drizzle");

export type TestDb = Db;

export async function createTestDb(): Promise<TestDb> {
  const client = createClient({ url: ":memory:" });
  await client.execute("PRAGMA foreign_keys = ON");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    await client.executeMultiple(sql);
  }
  return drizzle(client, { schema });
}
```

Note: the generated migration uses `--> statement-breakpoint` separators; `executeMultiple` runs the whole script including those as comments. If a file fails to apply, split on `--> statement-breakpoint` and `execute` each statement.

- [ ] **Step 3: Collapse the `Db` type (`repos/db.ts`)**

```typescript
// Shared repo db type: both the real libsql client (db.ts) and the in-memory
// libsql test client (test-db.ts) are the same LibSQLDatabase over `typeof
// schema` — repos are written once against this type and work against either.
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type * as schema from "../schema";

export type Db = LibSQLDatabase<typeof schema>;
```

- [ ] **Step 4: Update `drizzle.config.ts`**

Change only the dialect; keep the `.env.local` native-load block and the fail-loud `DATABASE_URL` check.

```typescript
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/server/persistence/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url,
  },
});
```

- [ ] **Step 5: Delete the Postgres migrations**

Run:
```bash
rm -rf drizzle/meta && rm -f drizzle/*.sql
```

- [ ] **Step 6: Generate the SQLite baseline**

Run: `npm run db:generate`
Expected: one new `drizzle/0000_*.sql` + fresh `drizzle/meta/`. No errors.

- [ ] **Step 7: Verify the baseline DDL**

Run:
```bash
grep -c 'PRIMARY KEY\|FOREIGN KEY\|CREATE UNIQUE INDEX\|WHERE' drizzle/0000_*.sql
grep -E 'resumes_user_id_active_unique|url_checks_queued_idx' drizzle/0000_*.sql
```
Expected: both partial indexes present; FK clauses and `WHERE` partial-index predicates present.

- [ ] **Step 8: Write the plumbing round-trip test**

`sources` has no raw SQL and no FK to `users`, so it isolates the plumbing.

```typescript
// src/server/persistence/plumbing.smoke.test.ts  (TEMPORARY — deleted in Step 10)
import { describe, expect, it } from "vitest";
import { createTestDb } from "./test-db";
import { sources } from "./schema";

describe("libsql plumbing", () => {
  it("round-trips json, boolean, and timestamp columns", async () => {
    const db = await createTestDb();
    const [row] = await db
      .insert(sources)
      .values({ id: "greenhouse", name: "Greenhouse", kind: "ats", persona: "both", enabled: true, config: { a: 1 } })
      .returning();
    expect(row.enabled).toBe(true);
    expect(row.config).toEqual({ a: 1 });
    expect(row.createdAt).toBeInstanceOf(Date);
    const [read] = await db.select().from(sources);
    expect(read.enabled).toBe(true);
    expect(read.config).toEqual({ a: 1 });
  });
});
```

- [ ] **Step 9: Run the round-trip test**

Run: `npx vitest run src/server/persistence/plumbing.smoke.test.ts`
Expected: PASS — proves libsql client, in-memory test client, migration replay, json/boolean/timestamp encoding all work.

- [ ] **Step 10: Delete the temporary test and commit**

```bash
rm src/server/persistence/plumbing.smoke.test.ts
git add -A
git commit -m "refactor(db): libsql driver, in-memory test harness, sqlite baseline"
```

**WAVE 1 EXIT GATE:** Step 9 passed. `getDb`/`createTestDb`/`Db` are libsql. Migration baseline applies. Repo files with raw SQL (`jobs.ts` etc.) may still fail typecheck/tests — that is Wave 2.

---

## WAVE 2 — Repo fragment ports (parallel)

Each task's exit gate is its own repo test file going green. Run these four concurrently.

### Task 4: urlChecks — queue claim, lease, sweep

**Goal:** Port the queue lease off Postgres locking/interval SQL onto the single-writer SQLite model. `executor`, **high** effort.

**Files:**
- Modify: `src/server/persistence/repos/urlChecks.ts`
- Modify: `src/server/persistence/repos/urlChecks.test.ts` (the `setLease` helper embeds pg SQL — spec exception)

**Interfaces:**
- Consumes: `Db` from T3; `urlChecks` table from T2.
- Produces: unchanged method signatures (`claimNextQueued`, `requeueOrphanedRunning`, `sweepExpiredLeases`, `updateStage`, `complete`, `fail`, `addCost`, `insert`, `getById`, `listActive`, `listByIds`).

- [ ] **Step 1: Run the existing tests to see them fail on SQLite**

Run: `npx vitest run src/server/persistence/repos/urlChecks.test.ts`
Expected: FAIL — `now()` / `interval` / `FOR UPDATE SKIP LOCKED` are not valid SQLite.

- [ ] **Step 2: Rewrite `claimNextQueued` (drop SKIP LOCKED, JS lease)**

```typescript
async claimNextQueued(): Promise<UrlCheckRow | null> {
  const [claimed] = await db
    .update(urlChecks)
    .set({
      status: "running",
      attempts: sql`${urlChecks.attempts} + 1`,
      leaseExpiresAt: new Date(Date.now() + 8 * 60_000),
    })
    .where(
      sql`${urlChecks.id} = (
        SELECT id FROM url_checks
        WHERE status = 'queued'
        ORDER BY created_at
        LIMIT 1
      )`,
    )
    .returning();
  return claimed ?? null;
},
```

Update the method comment: SQLite serializes writers, so the single `UPDATE … RETURNING` is atomic — no two workers claim the same row. Replace the `FOR UPDATE SKIP LOCKED` rationale text.

- [ ] **Step 3: Rewrite the sweep predicate**

Replace `const expired = sql\`${urlChecks.leaseExpiresAt} < now()\`;` with a drizzle operator:
```typescript
const expired = lt(urlChecks.leaseExpiresAt, new Date());
```
Ensure `lt` is imported from `drizzle-orm` (already imported in this file).

- [ ] **Step 4: Port the test helper `setLease`**

In `urlChecks.test.ts`, replace the three pg interval calls (lines ~192–194):
```typescript
await setLease(requeue.id, new Date(Date.now() - 60_000));
await setLease(fail.id, new Date(Date.now() - 60_000));
await setLease(healthy.id, new Date(Date.now() + 10 * 60_000));
```
Adjust `setLease`'s signature to take a `Date` and set it directly (`.set({ leaseExpiresAt: value })`) instead of a raw `sql` fragment.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/server/persistence/repos/urlChecks.test.ts`
Expected: PASS.

- [ ] **Step 6: Also run the delete-cascade / set-null coverage** (FK pragma proof)

Run: `npx vitest run src/server/jobs/delete-job.test.ts`
Expected: PASS — confirms `url_checks.job_id` `onDelete: set null` fires (i.e. `foreign_keys=ON` is active).

- [ ] **Step 7: Commit**

```bash
git add src/server/persistence/repos/urlChecks.ts src/server/persistence/repos/urlChecks.test.ts
git commit -m "refactor(db): port url-check queue lease to single-writer sqlite"
```

---

### Task 5: jobs — DISTINCT ON window rewrite, json_extract, ilike

**Goal:** Replace the Postgres-only `selectDistinctOn` and jsonb operators. `executor`, **high** effort.

**Files:**
- Modify: `src/server/persistence/repos/jobs.ts`

**Interfaces:**
- Consumes: `Db`, `jobs`/`jobScores` tables.
- Produces: unchanged `createJobsRepo` API (`upsertByDedupeKey`, `listScored`, `statsForQuery`, etc.).

- [ ] **Step 1: Run existing jobs tests to see them fail**

Run: `npx vitest run src/server/persistence/repos/jobs.test.ts`
Expected: FAIL / typecheck error — `selectDistinctOn` does not exist on `LibSQLDatabase`; `->>` invalid.

- [ ] **Step 2: Rewrite the `latestJobScores` subquery with a window function**

Replace the `.selectDistinctOn([jobScores.jobId], { id: jobScores.id })` subquery (the `latest_job_scores` CTE) with a `row_number()` window preserving the exact tie-break `created_at DESC, id DESC`:

```typescript
function latestJobScores() {
  const ranked = getDb()
    .select({
      id: jobScores.id,
      jobId: jobScores.jobId,
      rn: sql<number>`row_number() OVER (PARTITION BY ${jobScores.jobId} ORDER BY ${jobScores.createdAt} DESC, ${jobScores.id} DESC)`.as("rn"),
    })
    .from(jobScores)
    .as("ranked_job_scores");
  return getDb().select({ id: ranked.id }).from(ranked).where(eq(ranked.rn, 1)).as("latest_job_scores");
}
```

Preserve however the surrounding code consumes `latest_job_scores.id` (join key). Match the existing function's construction style — if it takes a `db` param, thread it through instead of calling `getDb()`.

- [ ] **Step 3: Port the tier filter (`->>` → `json_extract`)**

Replace `inArray(sql\`(${jobScores.legitimacy}->>'tier')\`, q.tier)` (and the `sql<string>\`(${jobScores.legitimacy}->>'tier')\`` select at ~line 327):
```typescript
inArray(sql`json_extract(${jobScores.legitimacy}, '$.tier')`, q.tier)
```
and
```typescript
tier: sql<string>`json_extract(${jobScores.legitimacy}, '$.tier')`,
```

- [ ] **Step 4: Port `ilike` → `like` and `now()` → `new Date()`**

- The `q.q` search: replace `ilike(jobs.title, like)` / `ilike(jobs.company, like)` with `like(jobs.title, like)` / `like(jobs.company, like)`. Update the import (`ilike` → `like` from `drizzle-orm`). Add a one-line comment: SQLite `LIKE` is ASCII-case-insensitive; accented chars become case-sensitive (acceptable at MVP).
- In `upsertByDedupeKey`, replace `set: { lastSeenAt: sql\`now()\`, aliases }` with `set: { lastSeenAt: new Date(), aliases }`.

- [ ] **Step 5: Run jobs tests**

Run: `npx vitest run src/server/persistence/repos/jobs.test.ts`
Expected: PASS — including listScored ordering (verifies the window rewrite's tie-break).

- [ ] **Step 6: Commit**

```bash
git add src/server/persistence/repos/jobs.ts
git commit -m "refactor(db): jobs distinct-on->window, jsonb->json_extract, ilike->like"
```

---

### Task 6: searchRuns — json_insert append, json_extract headline

**Goal:** Port the jsonb array-append and headline extraction. `executor`, **medium** effort.

**Files:**
- Modify: `src/server/persistence/repos/searchRuns.ts`

- [ ] **Step 1: Run existing tests to see them fail**

Run: `npx vitest run src/server/persistence/repos/searchRuns.test.ts`
Expected: FAIL — `::jsonb` and `->>` invalid on SQLite.

- [ ] **Step 2: Rewrite `appendResult` with `json_insert`**

```typescript
async appendResult(runId: string, userId: string, result: ScanResult): Promise<void> {
  await db
    .update(searchRuns)
    .set({ results: sql`json_insert(${searchRuns.results}, '$[#]', json(${JSON.stringify(result)}))` })
    .where(and(eq(searchRuns.id, runId), eq(searchRuns.userId, userId), eq(searchRuns.status, "running")));
},
```
Update the comment: SQLite runs the read-modify-write atomically under the single write lock — no lost writes; the fence on `status='running'` still prevents a terminal run from growing.

- [ ] **Step 3: Port the two headline COALESCE selects (`->>` → `json_extract`)**

Both the `listByUser` and `getDetail` selects:
```typescript
resumeName: sql<string>`COALESCE(${resumes.label}, json_extract(${resumes.structured}, '$.headline'), 'Résumé')`,
```

- [ ] **Step 4: Run searchRuns tests**

Run: `npx vitest run src/server/persistence/repos/searchRuns.test.ts`
Expected: PASS — including the concurrent-append and results-fencing cases.

- [ ] **Step 5: Commit**

```bash
git add src/server/persistence/repos/searchRuns.ts
git commit -m "refactor(db): searchRuns append via json_insert, headline via json_extract"
```

---

### Task 7: misc `now()` → `new Date()` (profile, applications, sessions)

**Goal:** Port the remaining trivial `now()` set-values. `executor`, **low** effort.

**Files:**
- Modify: `src/server/persistence/repos/profile.ts`
- Modify: `src/server/persistence/repos/applications.ts`
- Modify: `src/server/persistence/repos/sessions.ts`

- [ ] **Step 1: Run the three test files to see failures**

Run: `npx vitest run src/server/persistence/repos/profile.test.ts src/server/persistence/repos/applications.test.ts src/server/persistence/repos/sessions.test.ts`
Expected: FAIL where `now()` is used (any keyset-tuple `<` comparisons already work — do not change those).

- [ ] **Step 2: profile.ts — both `updatedAt: sql\`now()\`` → `new Date()`** (lines ~42, ~66)

```typescript
updatedAt: new Date(),
```

- [ ] **Step 3: applications.ts — `updatedAt: sql\`now()\`` → `new Date()`** (~line 171)

```typescript
.set({ ...p, updatedAt: new Date() })
```
Leave the keyset-tuple `sql` fragment (~line 102) unchanged — row-value comparison works in SQLite.

- [ ] **Step 4: sessions.ts — `lastUsedAt: sql\`now()\`` → `new Date()`** (~line 24)

```typescript
await db.update(sessions).set({ lastUsedAt: new Date() }).where(eq(sessions.tokenHash, tokenHash));
```

- [ ] **Step 5: Remove now-unused `sql` imports** only where a file no longer references `sql`.

Run: `grep -l 'sql`' src/server/persistence/repos/profile.ts src/server/persistence/repos/sessions.ts || true` — if a file no longer uses `sql`, drop it from its `drizzle-orm` import. (`applications.ts` still uses `sql` for the keyset tuple — keep it.)

- [ ] **Step 6: Run the three test files**

Run: `npx vitest run src/server/persistence/repos/profile.test.ts src/server/persistence/repos/applications.test.ts src/server/persistence/repos/sessions.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/persistence/repos/profile.ts src/server/persistence/repos/applications.ts src/server/persistence/repos/sessions.ts
git commit -m "refactor(db): now() -> new Date() in profile/applications/sessions"
```

**WAVE 2 EXIT GATE:** all four repo test files green.

---

## WAVE 3 — Fallout + verification

### Task 8: Smoke tests + docs

**Goal:** Retarget smoke to a `file:` scratch DB and correct the docs. `executor`, **low** effort.

**Files:**
- Modify/Rename: `src/smoke/postgres.smoke.test.ts` → `src/smoke/sqlite.smoke.test.ts`
- Modify: `src/smoke/setup.ts`
- Modify: `CLAUDE.md`, `docs/architecture/system-architecture.md`
- Modify: doc-comments in `src/server/resume/reextract.ts`, `src/server/resume/ingest.ts`, `src/server/resume/migrate-uploads.ts` (any `postgres://` reference)

- [ ] **Step 1: Rename + retarget the smoke test**

Run: `git mv src/smoke/postgres.smoke.test.ts src/smoke/sqlite.smoke.test.ts`
Update its body: any Postgres-specific setup (connection string, `postgres://`) → a scratch `file:` path. Keep the assertions.

- [ ] **Step 2: Update `setup.ts` guard copy**

The `DATABASE_URL` guard message "pointing at a SCRATCH database" stays valid; change any wording that implies Postgres. Keep the fail-loud throws.

- [ ] **Step 3: Fix docs**

- `CLAUDE.md` Persistence line: "Drizzle + Postgres (SQLite dev)" → "Drizzle + SQLite via libsql (embedded file; Turso-ready)".
- `docs/architecture/system-architecture.md`: update the persistence/data-model section's DB technology references (Postgres → SQLite/libsql). Do not change entity shapes.
- Update the `reextract.ts` / `ingest.ts` doc-comments that show `DATABASE_URL=postgres://…` to `file:./caliber.db`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(db): retarget smoke to sqlite scratch db; fix persistence docs"
```

---

### Task 9: Full verification gate

**Goal:** Prove the whole suite and a real runtime path. `executor`, **medium** effort.

**Files:** none (verification only; create `caliber.db` locally).

- [ ] **Step 1: Full test suite**

Run: `npm run test`
Expected: green. If any DB-backed suite fails, it names an unported fragment — fix in the owning repo and re-run.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Fresh DB generate + migrate + seed**

Run:
```bash
rm -f caliber.db
DATABASE_URL=file:./caliber.db npm run db:migrate
DATABASE_URL=file:./caliber.db npm run db:seed
```
Expected: migrate applies the baseline; seed inserts the operator profile + sources with no error.

- [ ] **Step 4: Runtime smoke (paste → queue → worker → scored)**

Use the `verify` skill recipe to boot the app against `DATABASE_URL=file:./caliber.db` with LLM test-doubles, paste a job URL, and confirm it moves queued → running → completed and appears scored. This exercises the two rewritten queries (`claimNextQueued`, `appendResult`) at runtime.
Expected: job reaches `completed`, visible in the feed.

- [ ] **Step 5: Confirm no Postgres references remain**

Run: `grep -rniE 'pg-core|pglite|postgres-js|gen_random_uuid|::jsonb|for update skip locked' src drizzle | grep -v node_modules || echo CLEAN`
Expected: `CLEAN`.

- [ ] **Step 6: Commit any final fixes**

```bash
git add -A && git commit -m "test(db): full-suite + runtime verification green on sqlite" || echo "nothing to commit"
```

**WAVE 3 EXIT GATE:** `npm run test` green, `tsc` clean, fresh-DB seed works, runtime paste flow completes, no Postgres residue.

---

## Review — R1: Fable diff review

**Goal:** Independent design/correctness review of the full migration diff by a `deep-thinker` (Fable) subagent, **high** effort, before merge.

- [ ] **Step 1: Produce the review diff**

Run: `git diff main...feat/sqlite-migration --stat` and full `git diff main...feat/sqlite-migration`.

- [ ] **Step 2: Dispatch the Fable reviewer** with this brief:
  - Verify the window-function rewrite reproduces Postgres `DISTINCT ON` semantics exactly (latest score per job, tie-break `created_at DESC, id DESC`), including behavior when a job has zero or multiple scores.
  - Verify `claimNextQueued` is race-free under the single-writer model and that the attempt-fence invariants (`updateStage`/`complete`/`fail`/`addCost` keyed on `attempts`) still hold.
  - Verify `json_insert('$[#]', json(?))` append equals the old `|| ::jsonb` semantics and stays fenced on `status='running'`.
  - Verify `foreign_keys=ON` is set on BOTH real and test connections (cascade/set-null correctness).
  - Confirm no contract/shape drift: `$inferSelect`/`$inferInsert` field names and TS types unchanged; timestamps still surface as `Date`; json columns still surface as typed objects.
  - Flag any silent-fallback or precision regression (D3 floats) that violates the project's fail-loud rule.

- [ ] **Step 3: Triage findings** via superpowers:receiving-code-review — apply real issues, push back on noise, re-run the affected tests.

- [ ] **Step 4: Finish the branch** via superpowers:finishing-a-development-branch (merge / PR decision).

---

## Self-review (plan vs spec)

- **Spec coverage:** deps (T1) · schema retype incl. all D-map rows (T2) · driver+pragmas (T3 db.ts) · test harness (T3 test-db.ts) · Db type (T3) · config+baseline (T3) · all 8 raw fragments — now() (T4/T5/T7), interval lease (T4), sweep lt (T4), attempts/cost arithmetic (kept, T4), `->>`×4 (T5/T6), `::jsonb` append (T6), DISTINCT ON (T5), keyset tuples (kept), ilike (T5) · smoke+docs (T8) · verification incl. FK-pragma + runtime (T9) · Fable review (R1, per user request). No gaps.
- **Placeholder scan:** every code step shows real code or a real command with expected output. No TBD/TODO.
- **Type consistency:** `Db = LibSQLDatabase<typeof schema>` used identically in T3/test-db/repos; method signatures unchanged; `latestJobScores` join key (`id`) preserved.
- **One spec exception surfaced:** `urlChecks.test.ts` needs edits (pg SQL in `setLease`) — folded into T4, noted against the spec's "62 untouched" claim.
