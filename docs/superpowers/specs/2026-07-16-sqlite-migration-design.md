# Postgres → SQLite (libsql) migration — design

**Date:** 2026-07-16
**Status:** approved (brainstorm), pending spec review
**Owner:** operator

## Goal

Move Caliber's persistence from PostgreSQL to SQLite via **libsql** as the single,
only dialect. Drop `postgres` and `@electric-sql/pglite` entirely. No dual-dialect
support. This is a persistence-layer swap only — no entity shape, API contract, repo
method signature, or business logic changes.

## Why libsql (not `better-sqlite3`)

Same driver and schema serve the whole growth path with only a connection-string
change at each step: embedded file now → managed remote (Turso) → embedded read
replicas → database-per-tenant. `better-sqlite3` can't reach the hosted/replica
steps. None of that staircase is built now; it's a connection string later. See the
scalability note in the brainstorm — the workload is I/O-bound on the LLM
(`scoreMatch` ~20–36s/job), read-heavy, write-light, and already per-user-scoped, all
of which suit single-writer SQLite well.

## Scope boundary

**In scope:** driver swap, schema retype, port ~8 raw SQL fragments, regenerate
migrations, swap the test harness, retarget smoke tests, update 3 docs.

**Out of scope:** any change to `src/types` contract, API routes' shapes, repo method
signatures, or business logic. All 62 test files' *expectations* stay byte-identical —
only the dialect underneath moves. No Turso/replica/multi-tenant-DB wiring (future,
connection-string only). No data migration (fresh start — see D5).

## Locked decisions

| # | Decision | Choice |
|---|---|---|
| D1 | Timestamps | `integer({ mode: "timestamp_ms" })` — repos keep reading/writing JS `Date`; ms precision; `withTimezone` dropped (epoch is UTC) |
| D2 | Primary keys | `text().primaryKey().$defaultFn(() => crypto.randomUUID())` — keep UUIDv4 text format so all ids/FKs/API shapes are unchanged; generated in JS |
| D3 | Numeric columns | `real()` (float64). `cost_usd`/`score`/`ats_score` are LLM cost estimates and scores, not a currency ledger — float is acceptable |
| D4 | Migrations | Regenerate one clean SQLite baseline; delete `drizzle/*.sql` + `drizzle/meta/` |
| D5 | Existing data | **Fresh start** — no data migration. Drop Postgres, create `caliber.db`, `db:seed`, re-upload résumé |
| D6 | Env | Keep var name `DATABASE_URL` (now `file:./caliber.db`); add optional `DATABASE_AUTH_TOKEN` for the future Turso step |

> **Tripwire (D6):** the Turso/remote step is not purely a connection-string swap — before switching, re-verify: (1) FK enforcement on the remote, (2) that the unique-violation catches in `users.ts`/`applications.ts` (which key on `cause.extendedCode === 'SQLITE_CONSTRAINT_UNIQUE'`, the LOCAL driver's error shape) still fire over hrana/HTTP, (3) pragma handling.
| D7 | JSON columns | `text({ mode: "json" }).$type<T>()` — drizzle stringifies on write, parses on read (×22 columns) |

## Change surface

### 1. Dependencies (`package.json`)
- Remove: `postgres`, `@electric-sql/pglite`
- Add: `@libsql/client`
- Keep: `drizzle-orm`, `drizzle-kit`

### 2. Schema retype (`src/server/persistence/schema.ts`) — `pg-core` → `sqlite-core`

Mechanical type map, all 13 tables:

| Postgres | SQLite |
|---|---|
| `pgTable` | `sqliteTable` |
| `uuid().primaryKey().defaultRandom()` | `text().primaryKey().$defaultFn(() => crypto.randomUUID())` |
| `jsonb(...).$type<T>()` | `text({ mode: "json" }).$type<T>()` |
| `jsonb(...).notNull().default([])` (searchRuns.results) | `text({ mode: "json" }).notNull().$defaultFn(() => [])` |
| `timestamp().notNull().defaultNow()` | `integer({ mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date())` |
| `timestamp("...", { withTimezone: true })` (users/sessions) | `integer({ mode: "timestamp_ms" })` — drop `withTimezone` |
| `timestamp()` nullable (postedAt, finishedAt, …) | `integer({ mode: "timestamp_ms" })` nullable |
| `numeric({ mode: "number" })` / `numeric({ precision, scale, mode })` | `real()` |
| `boolean()` | `integer({ mode: "boolean" })` |
| `integer()` | `integer()` (unchanged) |
| `text({ enum: [...] })` | unchanged (sqlite-core identical) |
| `.references(...)`, `.unique()`, `unique(...)`, `uniqueIndex(...).where(...)`, `index(...).where(...)` | unchanged (partial indexes + FKs supported) |
| `onDelete: "set null" / "cascade"` | unchanged (requires `PRAGMA foreign_keys=ON`) |

Update the file header comment (currently says "Postgres everywhere — see db.ts /
test-db.ts").

### 3. Raw SQL fragments

Eight hand-written `sql\`...\`` sites. Most simplify; two are real rewrites.

**Trivial / simplifies:**
- `sql\`now()\`` in `.set({...})` (profile.ts ×2, applications.ts, jobs.ts `lastSeenAt`,
  sessions.ts) → pass JS `new Date()` value.
- `now() + interval '8 minutes'` (urlChecks claim) → `new Date(Date.now() + 8*60_000)`.
- `${urlChecks.leaseExpiresAt} < now()` (sweep) → `lt(urlChecks.leaseExpiresAt, new Date())`.
- `${urlChecks.attempts} + 1`, `${urlChecks.costUsd} + ${usd}` → unchanged (column arithmetic identical).
- `(${jobScores.legitimacy}->>'tier')` (jobs.ts ×2) → `json_extract(${jobScores.legitimacy}, '$.tier')`.
- `${resumes.structured} ->> 'headline'` (searchRuns.ts ×2, inside COALESCE) →
  `json_extract(${resumes.structured}, '$.headline')`.
- `${searchRuns.results} || ${JSON.stringify([result])}::jsonb` (searchRuns.appendResult) →
  `json_insert(${searchRuns.results}, '$[#]', json(${JSON.stringify(result)}))`.
  Appends one element; SQLite executes the read-modify-write atomically under the
  single write lock — safe against lost writes (replaces the Postgres row-lock
  guarantee the current comment relies on; update that comment).
- keyset tuples `(a,b) < (SELECT a,b … )` (jobs.ts, applications.ts, searchRuns.ts) →
  **unchanged** (SQLite supports row-value comparison).
- `ilike(jobs.title/company, like)` (jobs.ts) → `like(...)`. SQLite `LIKE` is
  ASCII-case-insensitive; accented characters become case-sensitive — acceptable at
  MVP. Note in the code comment.

**Real rewrites (the actual work):**
- **`selectDistinctOn([jobScores.jobId], {...})`** in jobs.ts (`latestJobScores`
  subquery, "newest job_score per job") is Postgres-only. Rewrite with a window
  function: `row_number() OVER (PARTITION BY job_id ORDER BY created_at DESC, id DESC)`
  filtered to `rn = 1`. Preserve the exact tie-break (`desc(createdAt), desc(id)`).
- **`FOR UPDATE SKIP LOCKED`** in `urlChecks.claimNextQueued` — no SQLite equivalent
  and not needed. SQLite serializes writers, so
  `UPDATE … WHERE id = (SELECT id FROM url_checks WHERE status='queued' ORDER BY
  created_at LIMIT 1) RETURNING *` is atomic — two workers can't claim the same row.
  The concurrency guarantee moves from row-locks to the single-writer lock. Update the
  method comment (which currently explains the SKIP LOCKED rationale).

### 4. Driver (`src/server/persistence/db.ts`)

`drizzle-orm/postgres-js` + `postgres` → `drizzle-orm/libsql` + `@libsql/client`.
Singleton preserved. `getDb()` still throws if `DATABASE_URL` is unset (fail-loud).

On init, for `file:` URLs run PRAGMAs:
- `journal_mode=WAL` — concurrent readers never block the writer
- `foreign_keys=ON` — SQLite defaults OFF; our FKs/cascades depend on it
- `busy_timeout=5000` — writers wait instead of throwing `SQLITE_BUSY`

Remote `libsql://` URLs skip WAL (server handles concurrency) but still set
`foreign_keys=ON`. Pass `authToken` from `DATABASE_AUTH_TOKEN` when present.

### 5. Config (`drizzle.config.ts`)

`dialect: "postgresql"` → `"sqlite"`. Keep the `.env.local` native-load block and the
fail-loud `DATABASE_URL` check. Local `DATABASE_URL` example: `file:./caliber.db`.

### 6. Test harness (`src/server/persistence/test-db.ts`)

PGlite → `createClient({ url: ":memory:" })` (drizzle `drizzle-orm/libsql`). Fresh
isolated DB per test (matches PGlite isolation). Same migration-replay loop over
`drizzle/*.sql` — use `client.executeMultiple(sql)` per file (libsql runs
multi-statement scripts). Set `foreign_keys=ON`. **`createTestDb()` signature is
unchanged**, so all 62 consumers are untouched.

### 7. Repo `Db` type (`src/server/persistence/repos/db.ts`)

`PgDatabase<any, typeof schema>` → `LibSQLDatabase<typeof schema>`
(`drizzle-orm/libsql`). Both real and test clients are libsql now — the "two drivers,
one common type" comment is replaced with the single-type reality.

### 8. Migrations (`drizzle/`)

Delete `drizzle/*.sql` and `drizzle/meta/`. Run `npm run db:generate` against the new
sqlite schema → single `0000_*.sql` baseline. Verify the generated DDL includes the
partial indexes (`resumes_user_id_active_unique`, `url_checks_queued_idx`) and all FK
clauses.

### 9. Fallout

- `src/smoke/postgres.smoke.test.ts` + `src/smoke/setup.ts`: retarget the scratch DB
  to a `file:` path; rename the test file to drop "postgres". Keep the fail-loud env
  guards.
- `seed.ts`, `seed-test.ts`, `reextract.ts`, `migrate-uploads.ts`, `ingest.ts`: use
  `getDb()`/repos only — unaffected by the driver swap. Update any doc-comment that
  names Postgres/`postgres://`.
- Docs: CLAUDE.md ("Persistence" line — "SQLite dev" becomes literally true, note
  libsql), `docs/architecture/system-architecture.md` persistence section,
  `schema.ts` header. API contract (`api-contract.md`) untouched — entity shapes
  unchanged.

## Concurrency model (documented consequence)

SQLite is single-writer. Caliber has concurrent writers (url-check queue, parallel
scoring, scan workers), all I/O-bound on OpenRouter, writing results briefly after the
LLM returns. Under WAL this is fine: readers never block, writes serialize in
sub-millisecond windows, `busy_timeout` absorbs contention. The two rewritten queries
(§3) are the only places the single-writer model changes the implementation. **Rule
preserved by existing code:** never hold a write transaction open across an LLM call
(current code writes results *after* the call — unchanged).

## Verification

- `npm run test` (vitest) green — all 62 DB-backed suites pass against in-memory libsql.
- `npm run db:generate` produces a clean single baseline; `db:migrate` applies it to a
  fresh `caliber.db`.
- `npm run db:seed` succeeds against the fresh file DB.
- Manual: boot the app (`verify` skill recipe), paste a job → queue → worker → scored,
  confirming the rewritten `claimNextQueued` and `appendResult` work at runtime.
- `smoke:real` retargeted and (env-gated) runnable against a scratch `file:` DB.

## Risks

- **Window-function rewrite of `latestJobScores`** must reproduce the exact tie-break;
  covered by existing `jobs.ts` tests (listScored ordering).
- **JSON `->>` → `json_extract`**: the tier filter and headline COALESCE must return
  identical values; covered by existing filter/search tests.
- **`json_insert` append**: verify `results[]` grows correctly and stays fenced on
  `status='running'`; covered by searchRuns tests.
- **`foreign_keys=ON` must be set on every connection** (real + test), or cascade/set-null
  deletes silently no-op — covered by delete-cascade tests (delete-job, sessions).
- **Float `cost_usd`**: acceptable per D3; if exactness is ever required, revisit as
  `text` money-string — out of scope now.
