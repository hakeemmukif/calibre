# Parallel Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn "scoring fit" from a one-at-a-time, tab-blocking action into concurrent background scoring (up to 3 at once) for a single operator, surfaced as a persistent breathing UI that survives navigation and restarts.

**Architecture:** The existing `url_checks` table becomes a durable work queue. A boot-started `globalThis` worker singleton claims rows atomically (`FOR UPDATE SKIP LOCKED`), runs up to `SCORE_CONCURRENCY=3` pipelines concurrently via `p-limit`, and owns liveness via an 8-minute DB lease + attempt counter. The request handler stops executing pipelines (it enqueues + kicks the worker). On the client, a module-singleton `checksStore` (over `useSyncExternalStore`) replaces the single-run `useUrlCheck` hook and feeds three surfaces: a corner tray (`CheckDock`), a feed status card (`ScoringStatusCard`), and a details banner (`ReScoringBanner`). Every surface reads DB truth through one batched poll, which is what makes backgrounding, multi-tab, and restart-survival free.

**Tech Stack:** Next.js 15 (App Router, `next start` long-lived Node), React 19, TypeScript, Drizzle ORM + Postgres (PGlite in tests), `p-limit` (already a dependency), Vitest, Zod contract in `src/types`.

**Authoritative spec:** `docs/superpowers/specs/2026-07-13-parallel-scoring-design.md` — read it. Section references below (e.g. "spec §4.3") point there.

## Global Constraints

Every task's requirements implicitly include these — copied verbatim from the spec and `CLAUDE.md`:

- **LLM layer UNCHANGED.** No change to model (`openai/gpt-oss-120b`), provider routing, prompt, or streaming. All speed comes from concurrency + backgrounding. `runPipeline`'s internal LLM calls are untouched.
- **No new infra or dependencies.** No Redis, no pg-boss, no queue library. Queue = `url_checks` + Postgres `FOR UPDATE SKIP LOCKED`. `p-limit` is already a dependency.
- **No `userId` / auth / tenancy now.** `profile` stays a singleton (`id="default"`), `resume` via `resumesRepo.getActive()`. Choose primitives so adding `user_id` later is a column + `WHERE`, not a rewrite.
- **Fail loud at boundaries.** Validate with `Schema.parse`. No fallback defaults, no silent `0`/`""`/`unknown`.
- **`SCORE_CONCURRENCY = 3`** — a `const` beside the proven `SCORE_BATCH_SIZE` (`src/server/search/run.ts:32`), not an env var.
- **Lease (8 min) > any healthy run.** Server lease owns row liveness. The client keeps `MAX_POLL_FAILURES=8` (network resilience) but drops any hard run-deadline.
- **Fence every in-run row-write** on `status='running' AND attempts=$claimedAttempt` — not `status` alone (spec §4.4, the single most important correctness fix).
- **Cost cap = PAUSE, never fail.** Cap hit → worker stops claiming; queued rows stay queued.
- **`UrlCheck` wire shape is unchanged** — `attempts`/`lease_expires_at` are DB-internal, never serialized.
- **Layering:** UI → `features/*` → `server/*`. Only `server/*` touches the DB or the LLM. `features/*` never imports `@/server/*`.
- **Compose existing primitives.** No new keyframes, tokens, dependencies, portals, or toast/popover machinery. Breathing = `caliber-pulse` on non-text dots only; working = `caliber-spin` on `refresh-cw` in an `--accent-soft` circle.

**Ship milestone:** Tasks 1–4 (backend queue + worker + routes) produce working, tested software on their own — the *existing* `useUrlCheck` UI keeps functioning against the new backend (it polls `GET /api/jobs/check/:id`, which the worker updates). Tasks 5–10 replace that UI with the concurrent surfaces. A reviewer can merge after Task 4 if desired.

---

## File Structure

| Action | File | Responsibility |
| --- | --- | --- |
| Modify | `src/server/persistence/schema.ts` | Add `attempts`, `leaseExpiresAt`, partial queued-index to `url_checks` |
| Create | `drizzle/0007_*.sql` | Generated migration for the above |
| Modify | `src/server/persistence/repos/urlChecks.ts` | Atomic claim, lease/orphan recovery, list methods; fence the 4 in-run writes; drop `markAllUnfinishedAsFailed` |
| Create | `src/server/persistence/repos/urlChecks.test.ts` | Repo-level tests (claim, recovery, fencing, lists) |
| Modify | `src/server/url-check/run.ts` | Export `runPipeline`; thread `attempt` to all writes; strip pipeline-launch from `startUrlCheck` (enqueue + `kick()`); add list/paused server fns |
| Create | `src/server/url-check/worker.ts` | The queue worker singleton (claim → rehydrate → run; drain; sweep; pause-on-cap) |
| Create | `src/server/url-check/worker.test.ts` | Worker tests (rehydration, pause, serialized drain) |
| Modify | `src/server/url-check/run.test.ts` | Drive `runPipeline` directly; trim admission tests |
| Modify | `src/instrumentation.ts` | Replace boot-fail with `requeueOrphanedRunning()` + start worker |
| Modify | `src/app/api/jobs/check/route.ts` | Add `GET ?ids=` / `?active=1` batched handler |
| Create | `src/app/api/jobs/check/route.test.ts` | Route tests |
| Modify | `src/types/index.ts` | Add `UrlChecksSnapshot` (`{ checks: UrlCheck[]; paused: boolean }`) |
| Modify | `src/features/url-check/client.ts` | Add `getChecksByIds`, `getActiveChecks` |
| Create | `src/features/url-check/checksStore.ts` | Module-singleton store + `useUrlChecks()` |
| Create | `src/features/url-check/checksStore.test.ts` | Ported + new store tests |
| Delete | `src/features/url-check/useUrlCheck.ts` + `useUrlCheck.test.ts` | Replaced by the store |
| Modify | `src/caliber-ui/compositions/Feed/ScanProgress.tsx` | `export` `StageGlyph` + add `size` prop |
| Create | `src/caliber-ui/compositions/Shell/CheckRunRow.tsx` | Shared one-run row (glyph + label + state) |
| Create | `src/caliber-ui/compositions/Shell/CheckDock.tsx` | Corner tray |
| Create | `src/caliber-ui/compositions/Feed/ScoringStatusCard.tsx` | Feed status card |
| Create | `src/caliber-ui/compositions/Detail/ReScoringBanner.tsx` | Details re-scoring banner |
| Modify | `src/app/AppShell.tsx` | Mount `CheckDock` once (hidden on `/feed`) |
| Modify | `src/app/feed/page.tsx` | Swap hook → store; generalize reload effect; slot `ScoringStatusCard` |
| Modify | `src/app/jobs/[id]/page.tsx` | Derive evaluate status from store; `submitEvaluate`; render banner |
| Modify | `docs/architecture/api-contract.md` | Document the batched endpoints (`UrlCheck` unchanged) |

---

## Task 1: Schema — `attempts`, `leaseExpiresAt`, queued index

**Files:**
- Modify: `src/server/persistence/schema.ts:212-226` (the `urlChecks` table)
- Create: `drizzle/0007_*.sql` (generated)
- Test: `src/server/persistence/repos/urlChecks.test.ts` (new)

**Interfaces:**
- Produces: `urlChecks.attempts` (`integer NOT NULL DEFAULT 0`), `urlChecks.leaseExpiresAt` (`timestamp` nullable), partial index `url_checks_queued_idx` on `(status, created_at) WHERE status = 'queued'`. `UrlCheckRow` (`$inferSelect`) gains `attempts: number`, `leaseExpiresAt: Date | null`.

- [ ] **Step 1: Confirm current imports in `schema.ts`.**

Run: `grep -n "from \"drizzle-orm" src/server/persistence/schema.ts`
Expected: an import from `drizzle-orm/pg-core` (has `pgTable`, `integer`, `timestamp`, etc.) and possibly `sql` from `drizzle-orm`. Note whether `index` and `sql` are already imported.

- [ ] **Step 2: Add `index` and `sql` to imports if missing.**

In the `drizzle-orm/pg-core` import add `index`. Ensure `import { sql } from "drizzle-orm";` exists (add if absent). `integer` and `timestamp` are already imported (used elsewhere in the file).

- [ ] **Step 3: Add the two columns and the partial index to `urlChecks`.**

Replace the table's closing `});` (currently `src/server/persistence/schema.ts:226`) so the table gains the columns and a second `pgTable` callback arg:

```ts
export const urlChecks = pgTable(
  "url_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    url: text("url").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    status: text("status", { enum: ["queued", "running", "completed", "failed"] }).notNull(),
    stage: text("stage"),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    alreadyKnown: boolean("already_known").notNull(),
    needsText: boolean("needs_text").notNull(),
    error: jsonb("error").$type<{ code: string; message: string }>(),
    costUsd: numeric("cost_usd", { precision: 8, scale: 4, mode: "number" }).notNull(),
    raw: jsonb("raw").$type<unknown>().notNull(),
    // Governs orphan recovery only (max 2 attempts) — never in-run retries.
    attempts: integer("attempts").notNull().default(0),
    // Set at claim to now()+8min; the server lease owns row liveness (spec §4.7).
    leaseExpiresAt: timestamp("lease_expires_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
  },
  (t) => ({
    queuedIdx: index("url_checks_queued_idx").on(t.status, t.createdAt).where(sql`${t.status} = 'queued'`),
  }),
);
```

- [ ] **Step 4: Generate the migration.**

Run: `npm run db:generate`
Expected: a new `drizzle/0007_<name>.sql` adding `attempts`, `lease_expires_at`, and `CREATE INDEX ... url_checks_queued_idx ... WHERE status = 'queued'`. Open it and confirm those three statements are present and nothing else destructive.

- [ ] **Step 5: Write the failing schema test.**

Create `src/server/persistence/repos/urlChecks.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { createUrlChecksRepo } from "./urlChecks";

function queuedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    url: "https://example.com/job",
    dedupeKey: "example.com/job",
    status: "queued" as const,
    stage: null,
    jobId: null,
    alreadyKnown: false,
    needsText: false,
    error: null,
    costUsd: 0,
    raw: { text: null },
    ...overrides,
  };
}

describe("url_checks schema", () => {
  it("defaults attempts to 0 and leaseExpiresAt to null on insert", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);
    const row = await repo.insert(queuedRow());
    expect(row.attempts).toBe(0);
    expect(row.leaseExpiresAt).toBeNull();
  });
});
```

- [ ] **Step 6: Run the test — verify it PASSES.**

Run: `npx vitest run src/server/persistence/repos/urlChecks.test.ts`
Expected: PASS. (`createTestDb` applies all `drizzle/*.sql` including the new migration, so the columns exist.) If it fails with "column attempts does not exist", the migration didn't generate — recheck Step 4.

- [ ] **Step 7: Commit.**

```bash
git add src/server/persistence/schema.ts drizzle/ src/server/persistence/repos/urlChecks.test.ts
git commit -m "feat(url-check): add attempts + lease_expires_at + queued index to url_checks"
```

---

## Task 2: Repo — atomic claim, recovery, and list methods

**Files:**
- Modify: `src/server/persistence/repos/urlChecks.ts`
- Test: `src/server/persistence/repos/urlChecks.test.ts`

**Interfaces:**
- Consumes: Task 1 schema; `UrlCheckRow` type.
- Produces (all added to `createUrlChecksRepo` return + the `urlChecksRepo` facade):
  - `claimNextQueued(): Promise<UrlCheckRow | null>`
  - `requeueOrphanedRunning(maxAttempts?: number): Promise<{ requeued: number; failed: number }>` (default `maxAttempts = 2`)
  - `sweepExpiredLeases(maxAttempts?: number): Promise<{ requeued: number; failed: number }>` (default `2`)
  - `listActive(): Promise<UrlCheckRow[]>`
  - `listByIds(ids: string[]): Promise<UrlCheckRow[]>`

- [ ] **Step 1: Extend the drizzle-orm import.**

Top of `src/server/persistence/repos/urlChecks.ts` currently: `import { eq, inArray, sql } from "drizzle-orm";`. Add `and, gte, lt`:

```ts
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
```

- [ ] **Step 2: Write failing tests for `claimNextQueued`.**

Append to `src/server/persistence/repos/urlChecks.test.ts` (reuse the `queuedRow` helper):

```ts
describe("claimNextQueued", () => {
  it("flips the oldest queued row to running, sets attempts=1 and a future lease", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);
    const first = await repo.insert(queuedRow());
    await repo.insert(queuedRow());

    const claimed = await repo.claimNextQueued();

    expect(claimed?.id).toBe(first.id); // ORDER BY created_at
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.leaseExpiresAt).not.toBeNull();
    expect(claimed!.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("returns null when nothing is queued", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);
    expect(await repo.claimNextQueued()).toBeNull();
  });

  it("two sequential claims return two distinct rows", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);
    await repo.insert(queuedRow());
    await repo.insert(queuedRow());
    const a = await repo.claimNextQueued();
    const b = await repo.claimNextQueued();
    expect(a?.id).not.toBe(b?.id);
    expect(await repo.claimNextQueued()).toBeNull();
  });
});
```

- [ ] **Step 3: Run — verify it FAILS.**

Run: `npx vitest run src/server/persistence/repos/urlChecks.test.ts -t claimNextQueued`
Expected: FAIL — `repo.claimNextQueued is not a function`.

- [ ] **Step 4: Implement `claimNextQueued`.**

Add inside the object returned by `createUrlChecksRepo`, after `getById`:

```ts
    // Atomic claim (spec §4.4). One autocommit UPDATE — never wrapped in a
    // transaction (that would hold a connection across the ~30s run and defeat
    // SKIP LOCKED). The subquery is a raw sql fragment (mirrors the
    // sql`...` fragments already used in jobs.ts/applications.ts); .returning()
    // maps back to a typed UrlCheckRow.
    async claimNextQueued(): Promise<UrlCheckRow | null> {
      const [claimed] = await db
        .update(urlChecks)
        .set({
          status: "running",
          attempts: sql`${urlChecks.attempts} + 1`,
          leaseExpiresAt: sql`now() + interval '8 minutes'`,
        })
        .where(
          sql`${urlChecks.id} = (
            SELECT id FROM url_checks
            WHERE status = 'queued'
            ORDER BY created_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )`,
        )
        .returning();
      return claimed ?? null;
    },
```

- [ ] **Step 5: Run — verify claim tests PASS.**

Run: `npx vitest run src/server/persistence/repos/urlChecks.test.ts -t claimNextQueued`
Expected: PASS.

- [ ] **Step 6: Write failing tests for recovery + lists.**

Append:

```ts
describe("requeueOrphanedRunning", () => {
  it("requeues running rows under the attempt cap and fails those at/over it", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);
    const young = await repo.insert(queuedRow({ status: "running", attempts: 1, stage: "scoring" }));
    const old = await repo.insert(queuedRow({ status: "running", attempts: 2 }));
    const queued = await repo.insert(queuedRow()); // untouched

    const result = await repo.requeueOrphanedRunning();

    expect(result).toEqual({ requeued: 1, failed: 1 });
    expect((await repo.getById(young.id))?.status).toBe("queued");
    expect((await repo.getById(young.id))?.stage).toBeNull();
    expect((await repo.getById(old.id))?.status).toBe("failed");
    expect((await repo.getById(queued.id))?.status).toBe("queued");
  });
});

describe("listActive / listByIds", () => {
  it("listActive returns queued+running only, oldest first", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);
    await repo.insert(queuedRow({ status: "completed" }));
    const q = await repo.insert(queuedRow());
    const r = await repo.insert(queuedRow({ status: "running", attempts: 1 }));
    const active = await repo.listActive();
    expect(active.map((x) => x.id).sort()).toEqual([q.id, r.id].sort());
  });

  it("listByIds returns exact rows regardless of status; [] for empty input", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);
    const a = await repo.insert(queuedRow({ status: "completed" }));
    const b = await repo.insert(queuedRow({ status: "failed" }));
    await repo.insert(queuedRow());
    expect((await repo.listByIds([a.id, b.id])).map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(await repo.listByIds([])).toEqual([]);
  });
});
```

- [ ] **Step 7: Run — verify FAIL, then implement recovery + list methods.**

Run: `npx vitest run src/server/persistence/repos/urlChecks.test.ts` → FAIL (methods undefined). Add after `claimNextQueued`:

```ts
    // Boot recovery (spec §4.4) — replaces markAllUnfinishedAsFailed. On a
    // fresh process ALL running rows are orphaned (no in-memory owner): requeue
    // those within the attempt budget, terminal-fail the rest, leave queued
    // rows queued.
    async requeueOrphanedRunning(maxAttempts = 2): Promise<{ requeued: number; failed: number }> {
      const requeued = await db
        .update(urlChecks)
        .set({ status: "queued", stage: null, leaseExpiresAt: null })
        .where(and(eq(urlChecks.status, "running"), lt(urlChecks.attempts, maxAttempts)))
        .returning({ id: urlChecks.id });
      const failed = await db
        .update(urlChecks)
        .set({
          status: "failed",
          error: { code: "INTERNAL", message: "stale: process restarted after the retry budget was exhausted" },
          finishedAt: new Date(),
          leaseExpiresAt: null,
        })
        .where(and(eq(urlChecks.status, "running"), gte(urlChecks.attempts, maxAttempts)))
        .returning({ id: urlChecks.id });
      return { requeued: requeued.length, failed: failed.length };
    },

    // Runtime sweeper (spec §4.3) — only reaps running rows whose lease has
    // expired, so a healthy peer's in-flight rows (future lease) are left alone.
    async sweepExpiredLeases(maxAttempts = 2): Promise<{ requeued: number; failed: number }> {
      const expired = sql`${urlChecks.leaseExpiresAt} < now()`;
      const requeued = await db
        .update(urlChecks)
        .set({ status: "queued", stage: null, leaseExpiresAt: null })
        .where(and(eq(urlChecks.status, "running"), lt(urlChecks.attempts, maxAttempts), expired))
        .returning({ id: urlChecks.id });
      const failed = await db
        .update(urlChecks)
        .set({
          status: "failed",
          error: { code: "INTERNAL", message: "stale: lease expired after the retry budget was exhausted" },
          finishedAt: new Date(),
          leaseExpiresAt: null,
        })
        .where(and(eq(urlChecks.status, "running"), gte(urlChecks.attempts, maxAttempts), expired))
        .returning({ id: urlChecks.id });
      return { requeued: requeued.length, failed: failed.length };
    },

    async listActive(): Promise<UrlCheckRow[]> {
      return db
        .select()
        .from(urlChecks)
        .where(inArray(urlChecks.status, ["queued", "running"]))
        .orderBy(urlChecks.createdAt);
    },

    async listByIds(ids: string[]): Promise<UrlCheckRow[]> {
      if (ids.length === 0) return [];
      return db.select().from(urlChecks).where(inArray(urlChecks.id, ids));
    },
```

- [ ] **Step 8: Add the new methods to the `urlChecksRepo` facade.**

In the `export const urlChecksRepo` object at the bottom, add lines mirroring the existing style:

```ts
  claimNextQueued: () => createUrlChecksRepo(getDb()).claimNextQueued(),
  requeueOrphanedRunning: (maxAttempts) => createUrlChecksRepo(getDb()).requeueOrphanedRunning(maxAttempts),
  sweepExpiredLeases: (maxAttempts) => createUrlChecksRepo(getDb()).sweepExpiredLeases(maxAttempts),
  listActive: () => createUrlChecksRepo(getDb()).listActive(),
  listByIds: (ids) => createUrlChecksRepo(getDb()).listByIds(ids),
```

- [ ] **Step 9: Run the whole file + typecheck.**

Run: `npx vitest run src/server/persistence/repos/urlChecks.test.ts && npm run typecheck`
Expected: all PASS, no type errors.

- [ ] **Step 10: Commit.**

```bash
git add src/server/persistence/repos/urlChecks.ts src/server/persistence/repos/urlChecks.test.ts
git commit -m "feat(url-check): atomic claim + lease/orphan recovery + list repo methods"
```

---

## Task 3: Worker cutover — fence writes, thread `attempt`, own execution

This is the architectural cutover: execution moves from the fire-and-forget request handler into a boot-started worker, and the four in-run writes become attempt-fenced. These land together because the fence requires a claimed `attempts` value that only the worker provides — there is no correct intermediate state.

**Files:**
- Modify: `src/server/persistence/repos/urlChecks.ts` (fence `updateStage`/`addCost`/`complete`/`fail`; delete `markAllUnfinishedAsFailed`)
- Modify: `src/server/url-check/run.ts` (export `runPipeline`; add `attempt`; strip pipeline-launch from `startUrlCheck`)
- Create: `src/server/url-check/worker.ts`
- Modify: `src/instrumentation.ts`
- Modify: `src/server/url-check/run.test.ts` (drive `runPipeline` directly)
- Create: `src/server/url-check/worker.test.ts`

**Interfaces:**
- Consumes: Task 2 methods.
- Produces:
  - Fenced writes: `updateStage(id, stage, attempt)`, `addCost(id, usd, attempt)`, `complete(id, patch, attempt)`, `fail(id, patch, attempt)` — each `WHERE id AND status='running' AND attempts=attempt`, returning `null` on a fence miss.
  - `export async function runPipeline(checkId: string, req: UrlCheckRequest, ctx: { llm: LlmClient; resumeRow: ResumeRow; profile: ProfileRow; deps: Required<Omit<UrlCheckDeps, "llm">>; attempt: number }): Promise<void>`
  - `src/server/url-check/worker.ts`: `createUrlCheckWorker(overrides?: UrlCheckWorkerDeps)` → `{ kick(): Promise<void>; start(): void; stop(): void; drainOnce(): Promise<boolean>; isPaused(): boolean }`; singleton `urlCheckWorker`; `const SCORE_CONCURRENCY = 3`.
  - `startUrlCheck(req)` now enqueues + `urlCheckWorker.kick()`; the `deps` param is removed.

- [ ] **Step 1: Fence the four in-run writes.**

In `src/server/persistence/repos/urlChecks.ts` change the four methods to take `attempt` and fence. Example — `updateStage`:

```ts
    async updateStage(id: string, stage: string, attempt: number): Promise<UrlCheckRow | null> {
      const [updated] = await db
        .update(urlChecks)
        .set({ stage })
        .where(and(eq(urlChecks.id, id), eq(urlChecks.status, "running"), eq(urlChecks.attempts, attempt)))
        .returning();
      return updated ?? null;
    },
```

Apply the identical `and(eq(id), eq(status,"running"), eq(attempts, attempt))` fence to `complete`, `fail`, and `addCost` (each keeps its existing `.set({...})`; only the `.where(...)` and the new `attempt` param change). Update the facade lines to pass `attempt` through: `updateStage: (id, stage, attempt) => ...updateStage(id, stage, attempt)`, etc.

- [ ] **Step 2: Delete `markAllUnfinishedAsFailed`.**

Remove the `markAllUnfinishedAsFailed` method from both the factory object and the `urlChecksRepo` facade (its only caller, `instrumentation.ts`, is rewired in Step 8).

- [ ] **Step 3: Write the fenced-write test.**

Append to `src/server/persistence/repos/urlChecks.test.ts`:

```ts
describe("attempt-fenced writes", () => {
  it("a stale-attempt complete()/fail()/updateStage() no-ops against a row held by a newer attempt", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);
    // Row currently owned by attempt 2.
    const row = await repo.insert(queuedRow({ status: "running", attempts: 2 }));

    expect(await repo.updateStage(row.id, "scoring", 1)).toBeNull(); // stale
    expect(await repo.complete(row.id, { jobId: null as unknown as string, alreadyKnown: true }, 1)).toBeNull();
    expect((await repo.getById(row.id))?.status).toBe("running"); // untouched

    expect(await repo.updateStage(row.id, "scoring", 2)).not.toBeNull(); // owner
    expect((await repo.getById(row.id))?.stage).toBe("scoring");
  });
});
```

Run: `npx vitest run src/server/persistence/repos/urlChecks.test.ts -t fenced` → PASS.

- [ ] **Step 4: Thread `attempt` through `runPipeline` and export it.**

In `src/server/url-check/run.ts`:
1. Change the declaration to `export async function runPipeline(` (add `export`).
2. Add `attempt: number` to the `ctx` object type and destructure it: `const { llm, resumeRow, profile, deps, attempt } = ctx;`.
3. Pass `attempt` as the new last argument to every `urlChecksRepo.updateStage(...)`, `urlChecksRepo.addCost(...)`, and `urlChecksRepo.complete(...)` call inside `runPipeline` (there are several — search the function body for `urlChecksRepo.`).
4. Change `failCheck(checkId: string, err: Error)` to `failCheck(checkId: string, err: Error, attempt: number)` and pass `attempt` to `urlChecksRepo.fail(...)`; update the single call site in `runPipeline`'s `catch` to `await failCheck(checkId, error, attempt);`.

- [ ] **Step 5: Strip the pipeline launch out of `startUrlCheck`.**

In `startUrlCheck`, after the queued-row `insert` (currently `run.ts:331-343`), delete the `resolvedDeps`, `llm`, and `void runPipeline(...)` block (`run.ts:345-357`) and replace with a worker kick. Also remove the `deps` parameter (admission no longer runs anything). Final shape:

```ts
export async function startUrlCheck(req: UrlCheckRequest): Promise<{ check: UrlCheck; started: boolean }> {
  const resumeRow = await resumesRepo.getActive();
  if (!resumeRow) throw new NoActiveResumeError();

  if (req.text !== undefined && req.text.length > MAX_TEXT_CHARS) {
    throw new PayloadTooLargeError(req.text.length);
  }

  const dedupeKey = dedupeKeyFor(req.url);
  const existingJob = await jobsRepo.getByDedupeKey(dedupeKey);

  if (existingJob && (await jobsRepo.hasAnyScore(existingJob.id))) {
    const row = await urlChecksRepo.insert({
      id: crypto.randomUUID(), url: req.url, dedupeKey,
      status: "completed", stage: null, jobId: existingJob.id,
      alreadyKnown: true, needsText: false, error: null,
      costUsd: 0, raw: { text: req.text ?? null }, finishedAt: new Date(),
    });
    return { check: assemble(row), started: false };
  }

  const row = await urlChecksRepo.insert({
    id: crypto.randomUUID(), url: req.url, dedupeKey,
    status: "queued", stage: null, jobId: null,
    alreadyKnown: false, needsText: false, error: null,
    costUsd: 0, raw: { text: req.text ?? null },
  });

  urlCheckWorker.kick(); // fire-and-forget: enqueue then let the worker own execution
  return { check: assemble(row), started: true };
}
```

Add the import at the top of `run.ts`: `import { urlCheckWorker } from "./worker";`. Remove now-unused imports that only served the admission-launch path (check with `npm run typecheck` in Step 11 and delete whatever it flags as unused — likely nothing, since `getLlm`/`fetchPageText`/etc. are still used by `runPipeline`'s type references; do NOT remove imports `runPipeline` still needs).

> Note: `startUrlCheck` importing `worker.ts`, which imports `runPipeline` from `run.ts`, is a cycle. It resolves fine because `urlCheckWorker` is only *used* at call time (inside the function body), not at module-eval time — the same lazy pattern `instrumentation.ts` relies on. Do not call `urlCheckWorker.kick()` at module top level.

- [ ] **Step 6: Create the worker.**

Create `src/server/url-check/worker.ts`:

```ts
// Boot-started singleton that OWNS url-check execution (spec 2026-07-13 §4.3).
// Replaces the fire-and-forget `void runPipeline` in admission: pasting a URL
// enqueues a url_checks row and kicks this worker, which claims rows atomically
// (FOR UPDATE SKIP LOCKED), runs up to SCORE_CONCURRENCY at once via p-limit,
// and survives restarts via lease/attempts recovery. globalThis-guarded so
// Next dev bundle duplication / HMR never spawn two workers or two intervals
// (mirrors src/server/runs/registry.ts).
import pLimit from "p-limit";
import { getLlm, type LlmClient } from "@/lib/llm/client";
import { jobsRepo } from "@/server/persistence/repos/jobs";
import { jobScoresRepo } from "@/server/persistence/repos/jobScores";
import { profileRepo } from "@/server/persistence/repos/profile";
import { resumesRepo } from "@/server/persistence/repos/resumes";
import { urlChecksRepo, type UrlCheckRow } from "@/server/persistence/repos/urlChecks";
import { fetchGhostWebEvidence } from "@/server/score/ghost-web";
import { scoreJob } from "@/server/score";
import { UrlCheckRequest } from "@/types";
import { fetchPageText } from "./fetch-page";
import { runPipeline, type UrlCheckDeps } from "./run";
import { searchForPosting } from "./search-tier";

export const SCORE_CONCURRENCY = 3; // matches SCORE_BATCH_SIZE (search/run.ts:32) — proven concurrent gpt-oss-120b fan-out
const SWEEP_MS = 15_000;
const LEASE_MAX_ATTEMPTS = 2;

function startOfToday(): Date {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return start;
}

export interface UrlCheckWorkerDeps {
  runPipeline?: typeof runPipeline; // injected in tests
  pipelineDeps?: Required<Omit<UrlCheckDeps, "llm">>; // injected in tests
  llm?: LlmClient;
  dailyCapUsd?: number;
  concurrency?: number;
}

export function createUrlCheckWorker(overrides: UrlCheckWorkerDeps = {}) {
  const concurrency = overrides.concurrency ?? SCORE_CONCURRENCY;
  const limit = pLimit(concurrency);
  const run = overrides.runPipeline ?? runPipeline;
  const dailyCapUsd =
    overrides.dailyCapUsd ??
    (process.env.CALIBER_DAILY_LLM_USD ? Number(process.env.CALIBER_DAILY_LLM_USD) : undefined);

  let draining = false;
  let paused = false;
  let interval: ReturnType<typeof setInterval> | null = null;

  async function capReached(): Promise<boolean> {
    if (dailyCapUsd === undefined) return false;
    return (await jobScoresRepo.sumCostUsdSince(startOfToday())) >= dailyCapUsd;
  }

  async function process(row: UrlCheckRow): Promise<void> {
    const attempt = row.attempts;
    // Rehydrate (spec §4.6, the day-one bug): a URL-mode row has raw.text ===
    // null, which UrlCheckRequest.text (min(1).optional()) rejects. Coerce
    // null→undefined then parse so a malformed payload fails THIS row loudly,
    // never crashes the drain loop or silently enters paste-mode.
    let req: UrlCheckRequest;
    try {
      const raw = row.raw as { text: string | null };
      req = UrlCheckRequest.parse({ url: row.url, text: raw?.text ?? undefined });
    } catch (err) {
      await urlChecksRepo.fail(
        row.id,
        { code: "INTERNAL", message: `unrehydratable payload: ${err instanceof Error ? err.message : String(err)}`, needsText: false },
        attempt,
      );
      return;
    }

    // A duplicate that got scored while this row waited finishes as alreadyKnown
    // with zero LLM spend (spec §4.3 claim-time re-check).
    const existingJob = await jobsRepo.getByDedupeKey(row.dedupeKey);
    if (existingJob && (await jobsRepo.hasAnyScore(existingJob.id))) {
      await urlChecksRepo.complete(row.id, { jobId: existingJob.id, alreadyKnown: true }, attempt);
      return;
    }

    const resumeRow = await resumesRepo.getActive();
    if (!resumeRow) {
      await urlChecksRepo.fail(row.id, { code: "INTERNAL", message: "no active résumé at claim time", needsText: false }, attempt);
      return;
    }
    const profile = await profileRepo.get();
    const deps = overrides.pipelineDeps ?? { fetchPageText, searchForPosting, fetchGhostWebEvidence, scoreJob };
    const llm = overrides.llm ?? getLlm();
    await run(row.id, req, { llm, resumeRow, profile, deps, attempt });
  }

  // Serialized drain (spec §4.7 must-fix #4): a single in-flight flag guards the
  // loop so two kicks can't both claim into the same free slot. Claim while a
  // p-limit slot is free AND the cost cap is not hit; each finished job re-kicks.
  async function kick(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (limit.activeCount + limit.pendingCount < concurrency) {
        if (await capReached()) { paused = true; break; }
        paused = false;
        const row = await urlChecksRepo.claimNextQueued();
        if (!row) break;
        void limit(() => process(row)).then(() => void kick());
      }
    } finally {
      draining = false;
    }
  }

  // Test seam: claim + process exactly one row, AWAITED (kick fire-and-forgets
  // into p-limit, which is not awaitable from a test).
  async function drainOnce(): Promise<boolean> {
    if (await capReached()) { paused = true; return false; }
    paused = false;
    const row = await urlChecksRepo.claimNextQueued();
    if (!row) return false;
    await process(row);
    return true;
  }

  function start(): void {
    if (interval) return; // idempotent — never two intervals
    interval = setInterval(() => {
      void urlChecksRepo.sweepExpiredLeases(LEASE_MAX_ATTEMPTS).then(() => kick());
    }, SWEEP_MS);
    interval.unref?.(); // let tests/scripts exit
    void kick();
  }

  function stop(): void {
    if (interval) { clearInterval(interval); interval = null; }
  }

  return { kick, start, stop, drainOnce, isPaused: () => paused };
}

const g = globalThis as unknown as { __caliberUrlCheckWorker?: ReturnType<typeof createUrlCheckWorker> };
g.__caliberUrlCheckWorker ??= createUrlCheckWorker();
export const urlCheckWorker = g.__caliberUrlCheckWorker;
```

- [ ] **Step 7: Verify `jobsRepo.getByDedupeKey` / `hasAnyScore` signatures.**

Run: `grep -n "getByDedupeKey\|hasAnyScore" src/server/persistence/repos/jobs.ts`
Expected: both exist (`getByDedupeKey(dedupeKey: string)`, `hasAnyScore(jobId: string)`). If a name differs, adjust the worker to match — do not invent.

- [ ] **Step 8: Rewire boot recovery.**

Replace `src/instrumentation.ts` body so it requeues instead of failing, then starts the worker:

```ts
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { markStaleRunningOnBoot } = await import("@/server/runs/registry");
    await markStaleRunningOnBoot();
    const { urlChecksRepo } = await import("@/server/persistence/repos/urlChecks");
    await urlChecksRepo.requeueOrphanedRunning();
    const { urlCheckWorker } = await import("@/server/url-check/worker");
    urlCheckWorker.start();
  }
}
```

Keep the file's existing top comment; only the last two statements change (`markAllUnfinishedAsFailed` → `requeueOrphanedRunning` + `urlCheckWorker.start()`).

- [ ] **Step 9: Restructure `run.test.ts` — drive `runPipeline` directly.**

The old `runPipeline — needsText truth table` and `runPipeline — persisting edge cases` blocks drove the pipeline via `startUrlCheck(...)` fire-and-forget + `waitForTerminal`. `startUrlCheck` no longer runs the pipeline, so:

1. Add `runPipeline` to the destructured import from `./run` (top of file).
2. Add a helper that inserts a **running** row (attempts=1) and returns its id — the state a claim would leave:

```ts
async function insertRunningCheck(db: TestDb, req: { url: string; text?: string }): Promise<string> {
  const repo = createUrlChecksRepo(db);
  const row = await repo.insert({
    id: crypto.randomUUID(), url: req.url, dedupeKey: dedupeKeyFor(req.url),
    status: "running", stage: null, jobId: null, alreadyKnown: false,
    needsText: false, error: null, costUsd: 0, raw: { text: req.text ?? null }, attempts: 1,
  });
  return row.id;
}
```

3. For each pipeline test, replace the `startUrlCheck(...)` + `waitForTerminal(...)` dance with a direct call. The context needs a résumé + profile (insert via fixtures) and the same fake `deps` the test already builds. Pattern:

```ts
const checkId = await insertRunningCheck(db, { url: "https://example.com/job" });
await runPipeline(checkId, { url: "https://example.com/job" }, {
  llm, resumeRow, profile, attempt: 1,
  deps: { fetchPageText, searchForPosting, fetchGhostWebEvidence, scoreJob },
});
const row = await createUrlChecksRepo(db).getById(checkId);
expect(row?.status).toBe("failed"); // or "completed", per the case
```

`runPipeline` awaits fully (it owns its own try/catch → `failCheck`), so `waitForTerminal` is no longer needed for these — delete its use in the migrated blocks (keep the helper only if some remaining test still polls; otherwise remove it). Each migrated test keeps its existing mocked `deps` and assertions verbatim; only the invocation changes. `resumeRow`/`profile` come from `insertResume(db)` / `insertProfile(db)`.

4. The `startUrlCheck admission` block stays but drops pipeline concerns: the two tests that inject `{ llm: noCallLlm(calls) }` now call `startUrlCheck({ url })` (no deps param) and assert `started` + a `queued` row + `calls` empty (admission makes no LLM call by construction). The dedupe short-circuit test is unchanged (still returns `{ started: false }`).

- [ ] **Step 10: Write the worker tests.**

Create `src/server/url-check/worker.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { insertProfile, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { createUrlChecksRepo } from "@/server/persistence/repos/urlChecks";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import type { UrlCheckRequest } from "@/types";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { createUrlCheckWorker } = await import("./worker");

function queued(db: TestDb, url: string, text: string | null) {
  return createUrlChecksRepo(db).insert({
    id: crypto.randomUUID(), url, dedupeKey: url, status: "queued", stage: null,
    jobId: null, alreadyKnown: false, needsText: false, error: null, costUsd: 0, raw: { text },
  });
}

describe("url-check worker", () => {
  it("rehydrates a URL-mode row as text:undefined and a paste-mode row as its text", async () => {
    const db = await createTestDb();
    state.testDb = db;
    await insertSource(db);
    await insertResume(db);
    await insertProfile(db);
    const seen: UrlCheckRequest[] = [];
    const fakeRun = vi.fn(async (checkId: string, req: UrlCheckRequest, ctx: { attempt: number }) => {
      seen.push(req);
      await createUrlChecksRepo(db).fail(checkId, { code: "INTERNAL", message: "test-stop", needsText: false }, ctx.attempt);
    });

    await queued(db, "https://a.com/url-mode", null);
    await queued(db, "https://b.com/paste-mode", "Acme is hiring a Staff Engineer.");
    const worker = createUrlCheckWorker({ runPipeline: fakeRun as never });

    await worker.drainOnce();
    await worker.drainOnce();

    expect(seen).toHaveLength(2);
    expect(seen[0].text).toBeUndefined();      // URL mode
    expect(seen[1].text).toBe("Acme is hiring a Staff Engineer.");
  });

  it("pause-on-cap leaves the queued row queued and reports isPaused()", async () => {
    const db = await createTestDb();
    state.testDb = db;
    const row = await queued(db, "https://c.com/job", null);
    // dailyCapUsd 0 → spentToday (0) >= 0 → always capped.
    const worker = createUrlCheckWorker({ dailyCapUsd: 0, runPipeline: vi.fn() as never });

    const claimed = await worker.drainOnce();

    expect(claimed).toBe(false);
    expect(worker.isPaused()).toBe(true);
    expect((await createUrlChecksRepo(db).getById(row.id))?.status).toBe("queued");
  });

  it("serialized drain never runs more pipelines than the concurrency limit", async () => {
    const db = await createTestDb();
    state.testDb = db;
    await insertSource(db);
    await insertResume(db);
    await insertProfile(db);
    for (let i = 0; i < 6; i++) await queued(db, `https://d.com/job-${i}`, null);

    let active = 0;
    let maxActive = 0;
    const gate: Array<() => void> = [];
    const fakeRun = vi.fn(async (checkId: string, _req: unknown, ctx: { attempt: number }) => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => gate.push(resolve)); // hold the slot open
      active--;
      await createUrlChecksRepo(db).fail(checkId, { code: "INTERNAL", message: "done", needsText: false }, ctx.attempt);
    });
    const worker = createUrlCheckWorker({ concurrency: 3, runPipeline: fakeRun as never });

    await worker.kick();                              // fills 3 slots, then stops
    await new Promise((r) => setTimeout(r, 0));       // let p-limit promote pending→active
    expect(maxActive).toBeLessThanOrEqual(3);
    gate.splice(0).forEach((release) => release());   // drain the held jobs
  });
});
```

> Testing note (document, don't fight it): PGlite is single-connection, so true concurrent `FOR UPDATE SKIP LOCKED` contention across processes can't be unit-tested here — the "two sequential claims return distinct rows" test (Task 2) plus these serialized-drain assertions cover the in-process guarantees; cross-process arbitration is a Postgres property we rely on, noted in spec §6.

- [ ] **Step 11: Run everything backend + typecheck.**

Run: `npx vitest run src/server/ && npm run typecheck`
Expected: all PASS. Fix any unused-import lint the typecheck/`npm run check` surfaces (e.g. a now-unused symbol in `run.ts`). Common miss: `waitForTerminal` unused in `run.test.ts` → delete it.

- [ ] **Step 12: Commit.**

```bash
git add src/server/persistence/repos/urlChecks.ts src/server/url-check/run.ts src/server/url-check/worker.ts src/server/url-check/worker.test.ts src/server/url-check/run.test.ts src/instrumentation.ts
git commit -m "feat(url-check): worker owns execution — claim, fenced writes, boot recovery"
```

---

## Task 4: Routes — batched `?ids=` / `?active=1` + paused snapshot

**Files:**
- Modify: `src/types/index.ts:307` (after `UrlCheck`)
- Modify: `src/server/url-check/run.ts` (add `listActiveChecks`, `listChecksByIds`)
- Modify: `src/app/api/jobs/check/route.ts` (add `GET`)
- Test: `src/app/api/jobs/check/route.test.ts` (new)

**Interfaces:**
- Consumes: `urlChecksRepo.listActive`/`listByIds` (Task 2), `urlCheckWorker.isPaused()` (Task 3), `assemble` (`run.ts`).
- Produces:
  - `UrlChecksSnapshot` Zod: `{ checks: UrlCheck[]; paused: boolean }`.
  - `listActiveChecks(): Promise<UrlChecksSnapshot>` and `listChecksByIds(ids: string[]): Promise<UrlChecksSnapshot>` in `run.ts`.
  - `GET /api/jobs/check?active=1` → `UrlChecksSnapshot` (in-flight rows). `GET /api/jobs/check?ids=a,b,c` → `UrlChecksSnapshot` (exact rows). One request per client tick regardless of active-run count.

- [ ] **Step 1: Add `UrlChecksSnapshot` to the contract.**

In `src/types/index.ts`, immediately after the `UrlCheck` export (line ~307):

```ts
export const UrlChecksSnapshot = z.object({
  checks: z.array(UrlCheck),
  paused: z.boolean(), // true ⇔ worker is holding claims on the daily cost cap
});
export type UrlChecksSnapshot = z.infer<typeof UrlChecksSnapshot>;
```

- [ ] **Step 2: Add the server list functions.**

In `src/server/url-check/run.ts`, add near `getUrlCheck` (import `urlCheckWorker` is already added in Task 3; import `UrlChecksSnapshot` from `@/types`):

```ts
export async function listActiveChecks(): Promise<UrlChecksSnapshot> {
  const rows = await urlChecksRepo.listActive();
  return { checks: rows.map(assemble), paused: urlCheckWorker.isPaused() };
}

export async function listChecksByIds(ids: string[]): Promise<UrlChecksSnapshot> {
  const rows = await urlChecksRepo.listByIds(ids);
  return { checks: rows.map(assemble), paused: urlCheckWorker.isPaused() };
}
```

Add `UrlChecksSnapshot` to the existing `@/types` import in `run.ts`.

- [ ] **Step 3: Write failing route tests.**

Create `src/app/api/jobs/check/route.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

const listActive = vi.fn();
const listByIds = vi.fn();
vi.mock("@/server/url-check/run", () => ({
  listActiveChecks: () => listActive(),
  listChecksByIds: (ids: string[]) => listByIds(ids),
  startUrlCheck: vi.fn(),
}));

const { GET } = await import("./route");

function req(url: string) {
  return new Request(url) as unknown as import("next/server").NextRequest;
}

describe("GET /api/jobs/check", () => {
  it("?active=1 returns the active snapshot", async () => {
    listActive.mockResolvedValue({ checks: [], paused: false });
    const res = await GET(req("http://localhost/api/jobs/check?active=1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ checks: [], paused: false });
    expect(listActive).toHaveBeenCalledOnce();
  });

  it("?ids=a,b calls listChecksByIds with the split ids", async () => {
    listByIds.mockResolvedValue({ checks: [], paused: true });
    const res = await GET(req("http://localhost/api/jobs/check?ids=a,b"));
    expect(res.status).toBe(200);
    expect(listByIds).toHaveBeenCalledWith(["a", "b"]);
  });

  it("neither param → 422", async () => {
    const res = await GET(req("http://localhost/api/jobs/check"));
    expect(res.status).toBe(422);
  });
});
```

Run: `npx vitest run src/app/api/jobs/check/route.test.ts` → FAIL (`GET` not exported).

- [ ] **Step 4: Implement `GET`.**

In `src/app/api/jobs/check/route.ts`, add the `listActiveChecks`/`listChecksByIds` imports to the existing `@/server/url-check/run` import, and append:

```ts
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  if (searchParams.get("active") === "1") {
    return NextResponse.json(await listActiveChecks(), { status: 200 });
  }
  const idsParam = searchParams.get("ids");
  if (idsParam !== null) {
    const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean);
    return NextResponse.json(await listChecksByIds(ids), { status: 200 });
  }
  return errorResponse(422, "VALIDATION_ERROR", "Provide ?ids=<csv> or ?active=1.");
}
```

- [ ] **Step 5: Run tests + typecheck.**

Run: `npx vitest run src/app/api/jobs/check/route.test.ts && npm run typecheck` → PASS.

- [ ] **Step 6: Regenerate the contract and commit.**

Run: `npm run contract` (regenerates `contract/openapi.json` for `UrlChecksSnapshot`).

```bash
git add src/types/index.ts src/server/url-check/run.ts src/app/api/jobs/check/route.ts src/app/api/jobs/check/route.test.ts contract/openapi.json
git commit -m "feat(url-check): batched ?ids= / ?active=1 snapshot endpoints"
```

**← Backend ship milestone.** The queue, worker, recovery, and batched endpoints are complete and tested. The existing `useUrlCheck` UI still works (polls `GET :id`). Tasks 5–10 replace it with concurrent surfaces.

---

## Task 5: `checksStore` — the client collect-many store

**Files:**
- Modify: `src/features/url-check/client.ts` (add two fetchers)
- Create: `src/features/url-check/checksStore.ts`
- Create: `src/features/url-check/checksStore.test.ts`
- Delete: `src/features/url-check/useUrlCheck.ts`, `src/features/url-check/useUrlCheck.test.ts` (in Task 8, after the feed stops importing the hook — see note)

**Interfaces:**
- Consumes: `startCheck`, `getChecksByIds`, `getActiveChecks` (client), `evaluateJob`/`getJob` (`@/features/feed/client`), `UrlChecksSnapshot` (`@/types`).
- Produces `useUrlChecks()` returning exactly the shape in spec §5.1:

```ts
export type CheckRunPhase = "starting" | "queued" | "fetching" | "scoring" | "done" | "needsText" | "failed";
export interface CheckRun {
  key: string; checkId: string | null; url: string;
  origin: "paste" | "reevaluate"; jobId: string | null; job: Job | null;
  phase: CheckRunPhase; stage: string | null; alreadyKnown: boolean;
  error: { code: string; message: string } | null; startedAt: number; finishedAt: number | null;
}
export function useUrlChecks(): {
  runs: CheckRun[]; active: CheckRun[]; doneCount: number;
  submit(url: string, text?: string): string;
  submitEvaluate(jobId: string): string;
  retryWithText(key: string, text: string): void;
  dismiss(key: string): void;
  clearFinished(): void;
};
```

- [ ] **Step 1: Add the batched fetchers to the client.**

Append to `src/features/url-check/client.ts`:

```ts
import { UrlChecksSnapshot } from "@/types";

export async function getChecksByIds(ids: string[]): Promise<UrlChecksSnapshot> {
  return requestJson(`/api/jobs/check?ids=${encodeURIComponent(ids.join(","))}`, undefined, UrlChecksSnapshot);
}

export async function getActiveChecks(): Promise<UrlChecksSnapshot> {
  return requestJson(`/api/jobs/check?active=1`, undefined, UrlChecksSnapshot);
}
```

(Merge the `UrlChecksSnapshot` import into the existing `@/types` import line.)

- [ ] **Step 2: Write the store test harness (mirrors `useUrlCheck.test.ts`).**

Create `src/features/url-check/checksStore.test.ts` with the same mock seams the old test used, plus the new batched fetchers and `evaluateJob`:

```ts
// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, UrlCheck, UrlChecksSnapshot } from "@/types";

const startCheck = vi.fn();
const getChecksByIds = vi.fn();
const getActiveChecks = vi.fn();
const getJob = vi.fn();
const evaluateJob = vi.fn();

vi.mock("./client", () => ({
  startCheck: (...a: unknown[]) => startCheck(...a),
  getChecksByIds: (...a: unknown[]) => getChecksByIds(...a),
  getActiveChecks: (...a: unknown[]) => getActiveChecks(...a),
}));
vi.mock("@/features/feed/client", () => ({
  getJob: (...a: unknown[]) => getJob(...a),
  evaluateJob: (...a: unknown[]) => evaluateJob(...a),
}));

import { useUrlChecks, __resetChecksStore } from "./checksStore";

function check(o: Partial<UrlCheck> = {}): UrlCheck {
  return { id: "check-1", url: "https://example.com/job", status: "queued", stage: null, jobId: null,
    alreadyKnown: false, needsText: false, error: null, createdAt: "2026-07-13T00:00:00.000Z", finishedAt: null, ...o };
}
function snap(checks: UrlCheck[], paused = false): UrlChecksSnapshot { return { checks, paused }; }
function job(o: Partial<Job> = {}): Job { return { id: "job-1", /* ...same minimal fixture as useUrlCheck.test.ts... */ } as Job; }

beforeEach(() => { vi.useFakeTimers(); __resetChecksStore(); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
```

> Port the full `job()` fixture verbatim from `src/features/url-check/useUrlCheck.test.ts:47-69`.

- [ ] **Step 3: Write the failing behavioural tests.**

These are the spec §9 "Store" scenarios, translated from `useUrlCheck.test.ts`:

```ts
describe("checksStore", () => {
  it("two submits COLLECT (both survive) rather than supersede", async () => {
    startCheck.mockResolvedValueOnce(check({ id: "c1", status: "running", stage: "fetching" }))
              .mockResolvedValueOnce(check({ id: "c2", status: "running", stage: "fetching" }));
    const { result } = renderHook(() => useUrlChecks());
    await act(async () => { result.current.submit("https://a.com/1"); });
    await act(async () => { result.current.submit("https://b.com/2"); });
    expect(result.current.runs).toHaveLength(2);
    expect(result.current.active).toHaveLength(2);
  });

  it("submit dedupes an already-active URL (returns the existing key)", async () => {
    startCheck.mockResolvedValue(check({ id: "c1", status: "running", stage: "fetching" }));
    const { result } = renderHook(() => useUrlChecks());
    let k1 = "", k2 = "";
    await act(async () => { k1 = result.current.submit("https://a.com/1"); });
    await act(async () => { k2 = result.current.submit("https://a.com/1"); });
    expect(k1).toBe(k2);
    expect(result.current.runs).toHaveLength(1);
  });

  it("a completed poll fetches the Job, moves the run to done, bumps doneCount", async () => {
    startCheck.mockResolvedValue(check({ id: "c1", status: "running", stage: "scoring" }));
    getChecksByIds.mockResolvedValue(snap([check({ id: "c1", status: "completed", stage: "scoring", jobId: "job-1" })]));
    getJob.mockResolvedValue(job({ id: "job-1" }));
    const { result } = renderHook(() => useUrlChecks());
    await act(async () => { result.current.submit("https://a.com/1"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(result.current.runs[0].phase).toBe("done");
    expect(result.current.runs[0].job?.id).toBe("job-1");
    expect(result.current.doneCount).toBe(1);
  });

  it("dismiss(key) then a late poll for that key is a silent no-op", async () => {
    startCheck.mockResolvedValue(check({ id: "c1", status: "running", stage: "fetching" }));
    const { result } = renderHook(() => useUrlChecks());
    let key = "";
    await act(async () => { key = result.current.submit("https://a.com/1"); });
    act(() => { result.current.dismiss(key); });
    getChecksByIds.mockResolvedValue(snap([check({ id: "c1", status: "completed", jobId: "job-1" })]));
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(result.current.runs).toHaveLength(0); // dismissed run never resurrects
  });

  it("MAX_POLL_FAILURES consecutive batch failures fail only that run", async () => {
    startCheck.mockResolvedValue(check({ id: "c1", status: "running", stage: "fetching" }));
    getChecksByIds.mockRejectedValue(new Error("network blip"));
    const { result } = renderHook(() => useUrlChecks());
    await act(async () => { result.current.submit("https://a.com/1"); });
    for (let i = 0; i < 8; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(result.current.runs[0].phase).toBe("failed");
  });

  it("submitEvaluate wraps the synchronous evaluate as a done run with the fresh job", async () => {
    evaluateJob.mockResolvedValue(job({ id: "job-9" }));
    const { result } = renderHook(() => useUrlChecks());
    await act(async () => { result.current.submitEvaluate("job-9"); });
    expect(result.current.runs[0].origin).toBe("reevaluate");
    expect(result.current.runs[0].phase).toBe("done");
    expect(result.current.runs[0].job?.id).toBe("job-9");
  });
});
```

Run: `npx vitest run src/features/url-check/checksStore.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implement the store.**

Create `src/features/url-check/checksStore.ts`. Design notes baked in: a module singleton (not Context — `AppShell` persists across App Router navigations, spec §5.1); one shared 1.5s interval that batch-polls only runs with a `checkId` that are still present + non-terminal; `evaluate` runs are one-shot (no polling, resolved by the awaited `evaluateJob`); staleness is per-key presence (a snapshot applies only if the key is still in the map), so a `dismiss(key)` deletes it and late responses no-op naturally — no generation counter; `MAX_POLL_FAILURES=8` fails one run; **no** `MAX_RUN_MS` (server lease owns liveness, spec §5.1).

```ts
"use client";
import { useSyncExternalStore } from "react";
import type { Job, UrlCheck } from "@/types";
import { getJob, evaluateJob } from "@/features/feed/client";
import { startCheck, getChecksByIds } from "./client";

export type CheckRunPhase = "starting" | "queued" | "fetching" | "scoring" | "done" | "needsText" | "failed";

export interface CheckRun {
  key: string; checkId: string | null; url: string;
  origin: "paste" | "reevaluate"; jobId: string | null; job: Job | null;
  phase: CheckRunPhase; stage: string | null; alreadyKnown: boolean;
  error: { code: string; message: string } | null; startedAt: number; finishedAt: number | null;
}

const POLL_MS = 1500;
const MAX_POLL_FAILURES = 8;
const TERMINAL: ReadonlySet<CheckRunPhase> = new Set(["done", "needsText", "failed"]);

// Module-singleton state.
let runs: CheckRun[] = [];
let doneCount = 0;
const listeners = new Set<() => void>();
const pollFailures = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | null = null;

function emit() {
  // New array identity each change so useSyncExternalStore re-renders.
  runs = [...runs];
  for (const l of listeners) l();
}
function subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l); }
function upsert(key: string, patch: Partial<CheckRun>) {
  const i = runs.findIndex((r) => r.key === key);
  if (i === -1) return;
  runs[i] = { ...runs[i], ...patch };
  emit();
}
function phaseFor(c: UrlCheck): CheckRunPhase {
  if (c.status === "completed") return "done";
  if (c.status === "failed") return c.needsText ? "needsText" : "failed";
  // running/queued → split on server stage (never invented — raw passthrough)
  if (c.stage === "fetching" || c.stage === "searching") return "fetching";
  if (c.status === "queued") return "queued";
  return "scoring";
}

function ensureTimer() {
  if (timer) return;
  timer = setInterval(() => void pollTick(), POLL_MS);
}
function stopTimerIfIdle() {
  if (timer && !runs.some((r) => r.checkId && !TERMINAL.has(r.phase))) { clearInterval(timer); timer = null; }
}

async function pollTick() {
  const polling = runs.filter((r) => r.checkId && !TERMINAL.has(r.phase));
  if (polling.length === 0) { stopTimerIfIdle(); return; }
  let snapshot;
  try {
    snapshot = await getChecksByIds(polling.map((r) => r.checkId!) as string[]);
  } catch {
    for (const r of polling) {
      const n = (pollFailures.get(r.key) ?? 0) + 1;
      pollFailures.set(r.key, n);
      if (n >= MAX_POLL_FAILURES) applyTerminalFailure(r.key);
    }
    return;
  }
  const byId = new Map(snapshot.checks.map((c) => [c.id, c]));
  for (const r of polling) {
    const c = byId.get(r.checkId!);
    if (!c) continue; // key still ours, but row not returned — keep waiting
    pollFailures.set(r.key, 0);
    await applySnapshot(r.key, c);
  }
  stopTimerIfIdle();
}

async function applySnapshot(key: string, c: UrlCheck) {
  const phase = phaseFor(c);
  if (phase === "done") {
    let job: Job | null = null;
    try { job = c.jobId ? await getJob(c.jobId) : null; }
    catch { const n = (pollFailures.get(key) ?? 0) + 1; pollFailures.set(key, n); if (n >= MAX_POLL_FAILURES) applyTerminalFailure(key); return; }
    const i = runs.findIndex((r) => r.key === key);
    if (i === -1) return; // dismissed mid-fetch
    // Inline mutation + doneCount + a SINGLE emit — doneCount must change in
    // the same notification as the run, or the feed reload effect (keyed on
    // doneCount) never fires.
    runs[i] = { ...runs[i], phase, stage: c.stage, checkId: c.id, jobId: c.jobId, job, alreadyKnown: c.alreadyKnown, finishedAt: Date.now() };
    doneCount += 1;
    emit();
    return;
  }
  upsert(key, { phase, stage: c.stage, error: c.error, finishedAt: TERMINAL.has(phase) ? Date.now() : null });
}

function applyTerminalFailure(key: string) {
  upsert(key, { phase: "failed", error: { code: "POLL_FAILED", message: "Lost contact with the check." }, finishedAt: Date.now() });
}

function addRun(run: CheckRun) { runs = [run, ...runs]; emit(); }

// ---- public API (bound into the hook) ----
function submit(url: string, text?: string): string {
  const existing = runs.find((r) => r.url === url && !TERMINAL.has(r.phase) && r.origin === "paste");
  if (existing) return existing.key;
  const key = crypto.randomUUID();
  addRun({ key, checkId: null, url, origin: "paste", jobId: null, job: null, phase: "starting", stage: null, alreadyKnown: false, error: null, startedAt: Date.now(), finishedAt: null });
  pollFailures.set(key, 0);
  // Coerce empty text → undefined: UrlCheckRequest.text is min(1).optional(),
  // so a plain retry (retryWithText(key, "")) must NOT send text:"" (server
  // would 422). Empty ⇒ URL mode.
  const cleanText = text && text.length > 0 ? text : undefined;
  void startCheck({ url, text: cleanText })
    .then((c) => {
      if (!runs.some((r) => r.key === key)) return; // dismissed before start resolved
      upsert(key, { checkId: c.id, phase: phaseFor(c), stage: c.stage, alreadyKnown: c.alreadyKnown, error: c.error });
      if (c.status === "completed") void applySnapshot(key, c); // scored-dedupe short-circuit (202/200)
      else ensureTimer();
    })
    .catch(() => upsert(key, { phase: "failed", error: { code: "START_FAILED", message: "Couldn't start the check." }, finishedAt: Date.now() }));
  return key;
}

function submitEvaluate(jobId: string): string {
  const existing = runs.find((r) => r.jobId === jobId && r.origin === "reevaluate" && !TERMINAL.has(r.phase));
  if (existing) return existing.key;
  const key = crypto.randomUUID();
  addRun({ key, checkId: null, url: `job:${jobId}`, origin: "reevaluate", jobId, job: null, phase: "scoring", stage: "scoring", alreadyKnown: false, error: null, startedAt: Date.now(), finishedAt: null });
  void evaluateJob(jobId)
    .then((freshJob) => {
      const i = runs.findIndex((r) => r.key === key);
      if (i === -1) return; // dismissed mid-evaluate
      runs[i] = { ...runs[i], phase: "done", job: freshJob, finishedAt: Date.now() };
      doneCount += 1;
      emit(); // single notification carries both the run and doneCount
    })
    .catch(() => upsert(key, { phase: "failed", error: { code: "EVALUATE_FAILED", message: "Re-scoring failed." }, finishedAt: Date.now() }));
  return key;
}

function retryWithText(key: string, text: string) {
  const run = runs.find((r) => r.key === key);
  if (!run) return;
  dismiss(key);
  submit(run.url, text);
}
function dismiss(key: string) { runs = runs.filter((r) => r.key !== key); pollFailures.delete(key); emit(); stopTimerIfIdle(); }
function clearFinished() { runs = runs.filter((r) => !TERMINAL.has(r.phase)); emit(); stopTimerIfIdle(); }

// Test-only reset.
export function __resetChecksStore() {
  runs = []; doneCount = 0; pollFailures.clear();
  if (timer) { clearInterval(timer); timer = null; }
}

let snapshotCache = { runs, doneCount };
function getSnapshot() {
  // Return a NEW object when data changes so useSyncExternalStore re-renders;
  // keep the SAME reference when unchanged so it doesn't loop. (Mutating a
  // stable object would defeat the identity check and skip re-renders.)
  if (snapshotCache.runs !== runs || snapshotCache.doneCount !== doneCount) {
    snapshotCache = { runs, doneCount };
  }
  return snapshotCache;
}

export function useUrlChecks() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    runs: snap.runs,
    active: snap.runs.filter((r) => !TERMINAL.has(r.phase)),
    doneCount: snap.doneCount,
    submit, submitEvaluate, retryWithText, dismiss, clearFinished,
  };
}
```

> `getSnapshot` returns a cached object so `useSyncExternalStore` doesn't loop; `emit()` swaps the `runs` identity which flips the cache. The `active`/return object is rebuilt each render — acceptable (it's derived, and React only re-renders when `getSnapshot`'s identity changes).

- [ ] **Step 5: Run store tests + typecheck.**

Run: `npx vitest run src/features/url-check/checksStore.test.ts && npm run typecheck`
Expected: PASS. If `getSnapshot` identity causes an infinite loop warning, verify the cache swap in Step 4 is intact.

- [ ] **Step 6: Commit.** (`useUrlCheck.ts` is deleted in Task 8, once `feed/page.tsx` stops importing it — deleting now would break the build.)

```bash
git add src/features/url-check/client.ts src/features/url-check/checksStore.ts src/features/url-check/checksStore.test.ts
git commit -m "feat(url-check): checksStore — collect-many client store over batched polling"
```

---

## Task 6: Shared `CheckRunRow` + exported `StageGlyph`

**Files:**
- Modify: `src/caliber-ui/compositions/Feed/ScanProgress.tsx:24` (`StageGlyph`)
- Create: `src/caliber-ui/compositions/Shell/CheckRunRow.tsx`

**Interfaces:**
- Consumes: `CheckRun`, `CheckRunPhase` (`@/features/url-check/checksStore`) — but per layering, UI compositions may import feature *types* only. Import `import type { CheckRun } from "@/features/url-check/checksStore"`.
- Produces: `export function StageGlyph({ state, size }: { state: "pending" | "active" | "done"; size?: number })`; `export function CheckRunRow({ run, onRetry, onPasteText, onOpen, onDismiss }: CheckRunRowProps)`.

- [ ] **Step 1: Export `StageGlyph` + add a `size` prop.**

In `ScanProgress.tsx`, change `function StageGlyph({ state }: {...})` to:

```tsx
export function StageGlyph({ state, size = 26 }: { state: ScanProgressStageRow["state"]; size?: number }) {
```

Remove the internal `const size = 26;` line (now a prop with default 26 — existing callers pass nothing, unchanged). Everything else in the function is untouched.

- [ ] **Step 2: Write `CheckRunRow`.**

Create `src/caliber-ui/compositions/Shell/CheckRunRow.tsx`. It maps one `CheckRun` to a row: a `StageGlyph` (active/done/pending) + a label + state-specific caption/action. States per spec §5.2/§5.3.

```tsx
"use client";
import * as React from "react";
import { Icon } from "../../components/Icon";
import { Button } from "../../components/Button";
import { StageGlyph } from "../Feed/ScanProgress";
import type { CheckRun, CheckRunPhase } from "@/features/url-check/checksStore";

const GLYPH: Record<CheckRunPhase, "pending" | "active" | "done"> = {
  starting: "active", queued: "pending", fetching: "active", scoring: "active",
  done: "done", needsText: "pending", failed: "pending",
};
const LABEL: Record<CheckRunPhase, string> = {
  starting: "Starting…", queued: "Waiting for a slot", fetching: "Reading the posting",
  scoring: "Scoring fit · ghost check running alongside", done: "Scored",
  needsText: "Couldn’t read it automatically", failed: "Check failed",
};

export interface CheckRunRowProps {
  run: CheckRun;
  onOpen?(jobId: string): void;
  onRetry?(key: string): void;
  onPasteText?(key: string): void;
  onDismiss?(key: string): void;
}

export function CheckRunRow({ run, onOpen, onRetry, onPasteText, onDismiss }: CheckRunRowProps) {
  const title = run.origin === "reevaluate" ? "Re-scoring this role" : hostname(run.url);
  const done = run.phase === "done";
  const caption = done && run.alreadyKnown ? "Already in your feed" : LABEL[run.phase];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 4px", minWidth: 0 }}>
      {run.phase === "failed" ? <Icon name="triangle-alert" size={18} style={{ color: "var(--danger-ink)", flexShrink: 0 }} />
        : <StageGlyph state={GLYPH[run.phase]} size={22} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ font: "var(--type-label)", color: "var(--text-strong)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
        <div style={{ font: "var(--type-caption)", color: run.phase === "failed" ? "var(--danger-ink)" : "var(--text-muted)" }}>
          {run.phase === "failed" && run.error ? run.error.message : caption}
        </div>
      </div>
      {done && run.jobId && onOpen && <Button variant="ghost" onClick={() => onOpen(run.jobId!)}>View</Button>}
      {run.phase === "needsText" && onPasteText && <Button variant="secondary" onClick={() => onPasteText(run.key)}>Paste text</Button>}
      {run.phase === "failed" && onRetry && <Button variant="secondary" onClick={() => onRetry(run.key)}>Retry</Button>}
      {(done || run.phase === "failed" || run.phase === "needsText") && onDismiss && (
        <Button variant="ghost" onClick={() => onDismiss(run.key)}>Dismiss</Button>
      )}
    </div>
  );
}

function hostname(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}
```

- [ ] **Step 3: Typecheck + confirm existing `ScanProgress` tests still pass.**

Run: `npm run typecheck && npx vitest run src/caliber-ui`
Expected: PASS (the `size` default keeps existing `StageGlyph` usage identical). If there is a Storybook story or test snapshotting `ScanProgress`, it is unaffected.

- [ ] **Step 4: Commit.**

```bash
git add src/caliber-ui/compositions/Feed/ScanProgress.tsx src/caliber-ui/compositions/Shell/CheckRunRow.tsx
git commit -m "feat(url-check): export StageGlyph + shared CheckRunRow"
```

---

## Task 7: `CheckDock` — the corner tray + AppShell mount

**Files:**
- Create: `src/caliber-ui/compositions/Shell/CheckDock.tsx`
- Modify: `src/app/AppShell.tsx`

**Interfaces:**
- Consumes: `useUrlChecks()` (store), `CheckRunRow`, `usePathname`/`useRouter` (next).
- Produces: `export function CheckDock()`. Mounted once in `AppShell`, fixed bottom-right, **hidden on `/feed`** (the inline card owns that surface) and when there are no runs.

- [ ] **Step 1: Write `CheckDock`.**

Create `src/caliber-ui/compositions/Shell/CheckDock.tsx`. Collapsed = a breathing pill; expanded = up to 5 rows + `Clear finished`. Breathing is the `caliber-pulse` dot only (spec §5.2). It reads the store directly (a client composition wired to the feature is acceptable here — it is the app-shell surface, and `AppShell` is already a client component).

```tsx
"use client";
import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { Card } from "../../components/Card";
import { IconButton } from "../../components/IconButton";
import { Button } from "../../components/Button";
import { useUrlChecks } from "@/features/url-check/checksStore";
import { CheckRunRow } from "./CheckRunRow";

export function CheckDock() {
  const pathname = usePathname();
  const router = useRouter();
  const { runs, active, doneCount, dismiss, retryWithText, clearFinished } = useUrlChecks();
  const [expanded, setExpanded] = React.useState(false);
  const [seenDone, setSeenDone] = React.useState(0);

  // Hidden on /feed (inline ScoringStatusCard owns it) and when idle.
  if (pathname === "/feed" || runs.length === 0) return null;

  const unseen = Math.max(0, doneCount - seenDone);
  const shown = runs.slice(0, 5);
  const overflow = runs.length - shown.length;

  return (
    <div style={{ position: "fixed", right: 24, bottom: 24, zIndex: 40, width: expanded ? 320 : undefined }}>
      <Card radius="xl" elevation="lg" padding={expanded ? "md" : "sm"}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent-ink)", flexShrink: 0,
            animation: active.length > 0 ? "caliber-pulse 1.6s ease-in-out infinite alternate" : undefined }} />
          <div style={{ flex: 1, font: "var(--type-label)", color: "var(--text-strong)", fontVariantNumeric: "tabular-nums" }}>
            {active.length > 0 ? `Scoring ${active.length} role${active.length === 1 ? "" : "s"}` : "Checks"}
            {unseen > 0 && <span style={{ marginLeft: 6, font: "var(--type-caption)", color: "var(--accent-ink)" }}>{unseen} done</span>}
          </div>
          <IconButton icon={expanded ? "chevron-down" : "chevron-up"} label={expanded ? "Collapse" : "Expand"}
            onClick={() => { setExpanded((v) => !v); setSeenDone(doneCount); }} />
        </div>
        {expanded && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
            {shown.map((run) => (
              <CheckRunRow key={run.key} run={run}
                onOpen={(jobId) => router.push(`/jobs/${jobId}`)}
                onRetry={(key) => retryWithText(key, "")}
                onPasteText={() => router.push("/feed")}
                onDismiss={dismiss} />
            ))}
            {overflow > 0 && <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", padding: "4px" }}>+{overflow} more</div>}
            <Button variant="ghost" fullWidth onClick={clearFinished} style={{ marginTop: 4 }}>Clear finished</Button>
          </div>
        )}
      </Card>
    </div>
  );
}
```

> `retryWithText(key, "")` re-submits the original URL with no pasted text (a plain URL retry). The `needsText` "Paste text" action routes to `/feed`, where the paste box is bound (Task 8 handles binding by key).

- [ ] **Step 2: Confirm the icon names exist.**

Run: `grep -rn "chevron-up\|chevron-down" src/caliber-ui/components/Icon.tsx`
Expected: both present. If the Icon set uses different names (e.g. `chevron`), substitute the real names — do not invent.

- [ ] **Step 3: Mount in `AppShell`.**

In `src/app/AppShell.tsx`, import and render `CheckDock` inside the shell so it persists across routes. Add `import { CheckDock } from "@/caliber-ui/compositions/Shell/CheckDock";` and render it just before `</div>` (after `<main>`):

```tsx
      <main style={{ flex: 1, overflow: "auto", height: "100vh" }}>{children}</main>
      <CheckDock />
    </div>
```

- [ ] **Step 4: Typecheck + a smoke render test (optional but recommended).**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/caliber-ui/compositions/Shell/CheckDock.tsx src/app/AppShell.tsx
git commit -m "feat(url-check): CheckDock corner tray mounted in AppShell"
```

---

## Task 8: `ScoringStatusCard` + feed wiring (swap hook → store)

**Files:**
- Create: `src/caliber-ui/compositions/Feed/ScoringStatusCard.tsx`
- Modify: `src/app/feed/page.tsx`
- Delete: `src/features/url-check/useUrlCheck.ts`, `src/features/url-check/useUrlCheck.test.ts`

**Interfaces:**
- Consumes: `useUrlChecks()`, `CheckRunRow`, `EvalResultCard` (existing).
- Produces: `export function ScoringStatusCard({ runs, onOpen, onRetry, onPasteText, onDismiss }: ScoringStatusCardProps)`.

- [ ] **Step 1: Write `ScoringStatusCard`.**

Create `src/caliber-ui/compositions/Feed/ScoringStatusCard.tsx` — one `Card` (maxWidth 480), breathing header dot + `Scoring {N} roles in parallel`, one `CheckRunRow` per run. Renders only when there is ≥1 run.

```tsx
"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { CheckRunRow } from "../Shell/CheckRunRow";
import type { CheckRun } from "@/features/url-check/checksStore";

export interface ScoringStatusCardProps {
  runs: CheckRun[];
  onOpen(jobId: string): void;
  onRetry(key: string): void;
  onPasteText(key: string): void;
  onDismiss(key: string): void;
}

export function ScoringStatusCard({ runs, onOpen, onRetry, onPasteText, onDismiss }: ScoringStatusCardProps) {
  if (runs.length === 0) return null;
  const active = runs.filter((r) => r.phase === "starting" || r.phase === "queued" || r.phase === "fetching" || r.phase === "scoring");
  return (
    <Card padding="md" style={{ maxWidth: 480, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent-ink)",
          animation: active.length > 0 ? "caliber-pulse 1.6s ease-in-out infinite alternate" : undefined }} />
        <div>
          <div style={{ font: "var(--type-label)", color: "var(--text-strong)" }}>
            {active.length > 0 ? `Scoring ${active.length} role${active.length === 1 ? "" : "s"} in parallel` : "Checks"}
          </div>
          <div style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>
            each takes about 30 seconds — keep browsing, results drop into your feed
          </div>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {runs.map((run) => (
          <CheckRunRow key={run.key} run={run} onOpen={onOpen} onRetry={onRetry} onPasteText={onPasteText} onDismiss={onDismiss} />
        ))}
      </div>
    </Card>
  );
}
```

- [ ] **Step 2: Rewire `feed/page.tsx` from `useUrlCheck` to `useUrlChecks`.**

Changes to `src/app/feed/page.tsx`:
1. Replace `import { useUrlCheck } from "@/features/url-check/useUrlCheck";` with `import { useUrlChecks } from "@/features/url-check/checksStore";` and add `import { ScoringStatusCard } from "@/caliber-ui/compositions/Feed/ScoringStatusCard";`.
2. Replace `const urlCheck = useUrlCheck();` (line 94) with `const checks = useUrlChecks();`.
3. Replace the reload effect (lines 99-101) — generalize from `persona==='pasted'` on the single hook to `doneCount` on the store:

```tsx
  const prevDone = React.useRef(0);
  React.useEffect(() => {
    if (checks.doneCount > prevDone.current) { prevDone.current = checks.doneCount; void load(); }
  }, [checks.doneCount, load]);
```

4. `UrlEvalBar` (lines 156-162) now drives the store. `onSubmit` calls `checks.submit(url, text)`. Derive `urlEvalStatus`/`stageText`/`error`/`showPasteBox` from the **most recent paste run**:

```tsx
  const latestPaste = checks.runs.find((r) => r.origin === "paste");
  const urlEvalStatus: "idle" | "evaluating" | "success" | "error" =
    !latestPaste ? "idle"
    : latestPaste.phase === "done" ? "success"
    : latestPaste.phase === "failed" || latestPaste.phase === "needsText" ? "error"
    : "evaluating";
```

Replace the `UrlEvalBar` props: `status={urlEvalStatus}`, `stageText={latestPaste?.stage ?? undefined}`, `error={latestPaste?.error?.message}`, `showPasteBox={latestPaste?.phase === "needsText"}`, `onSubmit={(url, text) => checks.submit(url, text)}`.

5. Replace the `EvalResultCard` block (lines 178-191) with the `ScoringStatusCard` **plus** the most-recent completion's `EvalResultCard` (spec §5.3 — the status card sits in the old slot; the newest un-dismissed completed run also gets a full result card beneath it):

```tsx
        <div style={{ marginBottom: 16 }}>
          <ScoringStatusCard
            runs={checks.runs}
            onOpen={(jobId) => router.push(`/jobs/${jobId}`)}
            onRetry={(key) => checks.retryWithText(key, "")}
            onPasteText={() => { /* paste box already shown via showPasteBox on needsText */ }}
            onDismiss={checks.dismiss}
          />
        </div>
        {(() => {
          const latestDone = checks.runs.find((r) => r.phase === "done" && r.job);
          if (!latestDone?.job) return null;
          return (
            <div style={{ marginBottom: 16, display: "flex", justifyContent: "center" }}>
              <EvalResultCard
                job={latestDone.job}
                onOpen={() => router.push(`/jobs/${latestDone.job!.id}`)}
                onSave={() => {}}
                onTailor={() => router.push(`/jobs/${latestDone.job!.id}/tailor`)}
                onDismiss={() => checks.dismiss(latestDone.key)}
                alreadyKnownScopeLabel={latestDone.alreadyKnown ? scopeLabel(latestDone.job.persona) : undefined}
              />
            </div>
          );
        })()}
```

6. The `needsText` retry-with-text path: `UrlEvalBar`'s paste box (`showPasteBox`) submits via `onSubmit`, which calls `checks.submit(url, text)` — a fresh run. That matches today's behaviour (a new attempt with text). No `retryWithText`-by-key needed on the feed since the bar re-submits the URL directly.

- [ ] **Step 3: Delete the old hook + its test.**

```bash
git rm src/features/url-check/useUrlCheck.ts src/features/url-check/useUrlCheck.test.ts
```

Run: `grep -rn "useUrlCheck\b" src/` — expected: **no results** (only `useUrlChecks`). If anything still imports the singular hook, fix it before continuing.

- [ ] **Step 4: Typecheck + run feed-adjacent tests.**

Run: `npm run typecheck && npx vitest run src/features/url-check src/app/feed`
Expected: PASS. (If a `feed/page` test exists mocking `useUrlCheck`, update its mock to `useUrlChecks` returning the store shape.)

- [ ] **Step 5: Commit.**

```bash
git add -A src/caliber-ui/compositions/Feed/ScoringStatusCard.tsx src/app/feed/page.tsx src/features/url-check/
git commit -m "feat(url-check): ScoringStatusCard + feed wired to the collect-many store"
```

---

## Task 9: `ReScoringBanner` + details wiring

**Files:**
- Create: `src/caliber-ui/compositions/Detail/ReScoringBanner.tsx`
- Modify: `src/app/jobs/[id]/page.tsx`

**Interfaces:**
- Consumes: `useUrlChecks()`, existing `JobDetail` (unchanged — banner is a sibling, not a new prop).
- Produces: `export function ReScoringBanner({ phase, otherActive }: { phase: "fetching" | "scoring" | "done"; otherActive: number })`.

- [ ] **Step 1: Write `ReScoringBanner`.**

Create `src/caliber-ui/compositions/Detail/ReScoringBanner.tsx` — a slim `Card` with a breathing dot + spinning glyph + copy, a parallel-context suffix when other checks run (spec §5.4).

```tsx
"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import { StageGlyph } from "../Feed/ScanProgress";

export function ReScoringBanner({ phase, otherActive }: { phase: "fetching" | "scoring" | "done"; otherActive: number }) {
  const label = phase === "done" ? "Updated just now" : phase === "fetching" ? "Re-scoring this role — reading the posting" : "Re-scoring this role — scoring fit";
  return (
    <Card padding="sm" style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <StageGlyph state={phase === "done" ? "done" : "active"} size={22} />
        <div style={{ flex: 1 }}>
          <div style={{ font: "var(--type-label)", color: "var(--text-strong)" }}>
            {label}
            {phase !== "done" && otherActive > 0 && (
              <span style={{ color: "var(--text-muted)" }}>{` · ${otherActive} other check${otherActive === 1 ? "" : "s"} running`}</span>
            )}
          </div>
          {phase !== "done" && (
            <div style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>runs in the background — you can leave this page</div>
          )}
        </div>
      </div>
    </Card>
  );
}
```

- [ ] **Step 2: Rewire `jobs/[id]/page.tsx` to the store.**

Changes to `src/app/jobs/[id]/page.tsx`:
1. Add `import { useUrlChecks } from "@/features/url-check/checksStore";` and `import { ReScoringBanner } from "@/caliber-ui/compositions/Detail/ReScoringBanner";`. Remove `evaluateJob` from the `@/features/feed/client` import (the store owns evaluate now); keep `getJob`.
2. Replace the local `evaluateStatus` state + `handleEvaluate` (lines 32, 51-61) with store-derived state:

```tsx
  const checks = useUrlChecks();
  const myRun = checks.runs.find((r) => r.origin === "reevaluate" && r.jobId === id && r.phase !== "failed");
  const otherActive = checks.active.filter((r) => r.jobId !== id).length;
  const evaluateStatus: "idle" | "evaluating" | "error" =
    myRun && myRun.phase !== "done" ? "evaluating"
    : checks.runs.some((r) => r.origin === "reevaluate" && r.jobId === id && r.phase === "failed") ? "error"
    : "idle";

  // When our re-score completes, adopt the fresh job the store fetched.
  React.useEffect(() => {
    if (myRun?.phase === "done" && myRun.job && myRun.job !== job) setJob(myRun.job);
  }, [myRun?.phase, myRun?.job, job]);
```

3. `onEvaluate` now calls the store: `onEvaluate={() => checks.submitEvaluate(job.id)}`. Keep `evaluateStatus={evaluateStatus}` (the existing `JobDetail` prop, unchanged).
4. Render `ReScoringBanner` as a sibling above `JobDetail` (spec §5.4 — not a `JobDetail` prop):

```tsx
        {myRun && (myRun.phase === "fetching" || myRun.phase === "scoring" || myRun.phase === "done") && (
          <ReScoringBanner phase={myRun.phase} otherActive={otherActive} />
        )}
        <JobDetail ... />
```

- [ ] **Step 3: Typecheck + details tests.**

Run: `npm run typecheck && npx vitest run src/app/jobs`
Expected: PASS. Update any `jobs/[id]/page` test that mocked `evaluateJob`/`evaluateStatus` to the store-driven shape.

- [ ] **Step 4: Commit.**

```bash
git add src/caliber-ui/compositions/Detail/ReScoringBanner.tsx src/app/jobs/[id]/page.tsx
git commit -m "feat(url-check): ReScoringBanner — re-evaluate as a background run"
```

---

## Task 10: Docs + full verification

**Files:**
- Modify: `docs/architecture/api-contract.md`

- [ ] **Step 1: Document the batched endpoints.**

In `docs/architecture/api-contract.md` §5 (url-check), add entries for `GET /api/jobs/check?ids=<csv>` and `GET /api/jobs/check?active=1`, both returning `UrlChecksSnapshot { checks: UrlCheck[]; paused: boolean }`. Note explicitly that the `UrlCheck` shape is unchanged and that `POST /api/jobs/check` now returns `202` (queued) via the worker. Follow the section's existing formatting.

- [ ] **Step 2: Full check.**

Run: `npm run check`
Expected: `typecheck` clean, all vitest green, `contract:check` clean (openapi already regenerated in Task 4 — if it reports a diff, run `npm run contract` and re-add), `next build` succeeds.

- [ ] **Step 3: Drive it end-to-end (the real acceptance test — spec handoff step 4).**

Use `/run` or `/verify`. Manually:
1. Paste 3+ different job URLs quickly on `/feed`. Confirm the `ScoringStatusCard` shows 3 rows scoring **in parallel** (multiple spinning glyphs at once), not sequentially.
2. Navigate to `/tracker` mid-run. Confirm the `CheckDock` corner tray appears bottom-right and keeps breathing.
3. Restart the dev/prod process (`next start`) mid-run. Confirm queued/running rows resume (worker `requeueOrphanedRunning` + claim) instead of dying — reload `/feed` and watch them finish.
4. On a `/jobs/:id`, click re-evaluate; confirm the `ReScoringBanner` appears, the page stays usable, and the job updates on completion.

- [ ] **Step 4: Commit + finish.**

```bash
git add docs/architecture/api-contract.md contract/openapi.json
git commit -m "docs(url-check): document batched check endpoints + 202 admission"
```

Then use the **superpowers:finishing-a-development-branch** skill to decide merge/PR.

---

## Self-Review

**1. Spec coverage** (spec §-by-§):
- §4.2 schema (attempts, lease, partial index) → Task 1. ✓
- §4.3 worker (globalThis singleton, pLimit=3, serialized kick, 15s unref interval, per-claim rehydrate + hasAnyScore recheck + resume/profile fetch) → Task 3. ✓
- §4.4 repo (claim SQL, requeue/fail expired, requeueOrphanedRunning, listActive/listByIds, fence 4 writes) → Tasks 2–3. ✓
- §4.5 routes (POST→202 + kick; `?ids=`; `?active=1`; `:id` kept) → Tasks 3 (POST kick, 202 already mapped by existing route via `started`) + 4 (GET). ✓
- §4.6 rehydration → Task 3 worker `process()` + worker test. ✓
- §4.7 invariants (fencing, lease>client, autocommit claim, idempotent re-run, terminal-failure semantics unchanged, deleted-job fall-through) → Tasks 2–3. Deleted-job: `runPipeline` already handles `complete()` with a jobId; the worker's `hasAnyScore` recheck uses `getByDedupeKey` which returns null if deleted → falls through to a normal run. ✓
- §4.8 concurrency + cost cap PAUSE → Task 3 worker `capReached`/`isPaused`. ✓
- §5.1 checksStore (collect not supersede, per-key staleness, shared 1.5s interval, MAX_POLL_FAILURES, no MAX_RUN_MS, getJob on completion, `?active=1` hydration) → Task 5. **Gap found + noted:** `?active=1` reload hydration is *available* (endpoint + `getActiveChecks` client fn exist) but the store does not auto-call it on mount. Spec §5.1 says the store "may" hydrate — deferring the mount-hydration wiring is acceptable for MVP (in-memory ids survive SPA nav; only a hard refresh loses them). **Added a note in Task 5** rather than a task; flag for the executor if hard-refresh persistence is required.
- §5.2 CheckDock → Task 7. ✓  §5.3 ScoringStatusCard → Task 8. ✓  §5.4 ReScoringBanner → Task 9. ✓  §5.5 motion/StageGlyph export/CheckRunRow → Task 6. ✓
- §9 testing (worker claim/lease/fence/rehydrate/pause/serialized-drain; store port; route) → Tasks 2–5. ✓ (PGlite cross-process concurrency limitation documented in Task 3.)
- §10 file inventory → File Structure table matches. ✓

**2. Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N". The one deliberate pointer — "port the `job()` fixture verbatim from useUrlCheck.test.ts:47-69" — cites exact lines, not a vague reference. Component styling values are concrete (copied from `ScanProgress`/tokens).

**3. Type consistency:**
- Fenced writes gain `attempt: number` as the **last** param everywhere (`updateStage`/`addCost`/`complete`/`fail`) — worker + runPipeline both pass it last. ✓
- `runPipeline` ctx adds `attempt` — worker passes `attempt: row.attempts`; run.test.ts passes `attempt: 1`. ✓
- `CheckRunPhase` union identical in `checksStore.ts`, `CheckRunRow.tsx`, and consumers. ✓
- `UrlChecksSnapshot { checks, paused }` identical in types, client, server fns, route, store. ✓
- `useUrlChecks()` return shape matches spec §5.1 exactly (`runs`/`active`/`doneCount`/`submit`/`submitEvaluate`/`retryWithText`/`dismiss`/`clearFinished`). ✓

**Fixes applied inline:** (a) flagged the `?active=1` mount-hydration as an explicit MVP deferral in §5.1 coverage; (b) noted the `run.ts`↔`worker.ts` import cycle is safe because `kick()` is called lazily, with an instruction not to invoke it at module top-level; (c) documented the PGlite single-connection limit so the executor doesn't try to write an unrunnable cross-process race test.
