# Scan Observability — M1 (History + Scans Tab) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every scan's per-job results incrementally to `search_runs`, expose a user-scoped run list + detail over the API, and build the `/scans` tab (list + launcher) and `/scans/:id` phased replay — retiring the Feed `ScanProgress` overlay and `scanHandoff` so a scan has exactly one home.

**Architecture:** Columns-only migration on `search_runs` (a `results` jsonb + widened `stats` jsonb shape) — no join table, no new table, so the multitenant scoping-audit surface is unchanged (`search_runs.user_id` still gates every read). The M0 rolling pool (already merged) appends one `ScanResult` per settling job under a status-fenced jsonb write; Postgres row-locking serializes the concurrent pool tasks. UI is client pages calling `features/search/client` → API routes that do `requireUser()`, matching every existing `(app)` page.

**Tech Stack:** TypeScript, Next.js 15 (App Router, Node runtime), Drizzle ORM 0.45 + drizzle-kit 0.31, Postgres / PGlite (in-process test DB), Zod, Vitest, custom `caliber-ui` design system, `lucide-react` icons via the local `Icon` map.

## Global Constraints

- **Layering:** UI (`app/(app)/*`, client) → `features/*/client` → API route → `server/*`; only `server/*` touches the DB or the LLM.
- **Fail loud:** validate at boundaries with `Schema.parse`; no fallback defaults, no silent `0`/`""`/`unknown`. A missing required value throws a specific error.
- **Contract is Zod:** `src/types/index.ts` Zod schemas are the source of truth; regenerate `docs/architecture/api-contract.md` when they change.
- **Multitenancy:** every `search_runs` read is `user_id`-scoped. `appendResult` and every list/detail read filter by `userId`. No cross-tenant read is added.
- **Surgical diffs:** match existing style; every changed line traces to this plan; no speculative abstractions, no backwards-compat shims.
- **Green gate:** `npm run check` (typecheck + vitest + contract + build) must pass before M1 is done.
- **`ScanResult` is bounded ≤30:** only the top-N scored candidates get a result row. Pre-filter cuts (relocation/tz drops, discover→top-30 slice) stay as aggregate `stats` counts, never result rows.

## Task Assignments (model · effort · goal)

| Task | Agent / model | Effort | Verifiable goal |
|------|---------------|--------|-----------------|
| 1 — Contract types | `executor` (sonnet) | medium | `ScanResult`, `SearchRunSummary`, `ScanDetail` Zod schemas exist; `SearchRun.stats` widened; `npm run typecheck` + contract check green |
| 2 — Migration + persisted shape | `executor` (sonnet) | medium | `results` jsonb column + extended `SearchRunStats` type; `db:generate` produces one migration; PGlite test DB boots with the column |
| 3 — Repo (`appendResult` / `listByUser` / `getDetail`) | `deep-thinker` (fable) | high | Fenced concurrent-append + paginated user-scoped list with résumé-name join; repo unit tests green |
| 4 — Wire incremental writes + partial-fail into `run.ts` | `deep-thinker` (fable) | high | Each settling job appends a `ScanResult`; discover/score durations + `costUsd` recorded; `failRun` persists partial stats+results; run suite green |
| 5 — API: list + detail JSON | `executor` (sonnet) | medium | `GET /api/search` paginated list; `GET /api/search/:id` JSON includes `results` + widened `stats`; route tests green |
| 6 — `features/search/client` typed readers | `executor` (sonnet) | low | `listScans` / `getScanDetail` return Zod-parsed types; compiles + unit test |
| 7 — Nav item | `executor` (sonnet) | low | "Scans" appears under Pipeline, routes to `/scans`; sidebar test green |
| 8 — `/scans` list page + `ScansList` + launcher | `executor` (sonnet) | medium | Page lists runs (résumé, duration, verdict mix, status badge), launches a scan; dom test green |
| 9 — `/scans/:id` replay + `ScanReplay` | `executor` (sonnet) | medium | Phased replay (Discover → sortable Score list → Legitimacy aggregate) from persisted `results`; dom test green |
| 10 — Retire `ScanProgress` + `scanHandoff` (D7) | `deep-thinker` (fable) | high | Feed "Scan now" → `/scans/:id`; dual-persona → `/scans`; overlay + handoff deleted; feed/resume tests green |
| 11 — Full-gate verification | `executor` (sonnet) | low | `npm run check` fully green; contract + component-inventory docs regenerated |

> Effort maps to `opts.effort` when dispatched via a workflow; when dispatched as a plain subagent, "high" tasks go to `deep-thinker` (fable, escalate to opus if unavailable) and the rest to `executor`.

---

### Task 1: Contract types — `ScanResult`, `SearchRunSummary`, `ScanDetail`, widened `SearchRun.stats`

**Model · effort · goal:** `executor` (sonnet) · medium · The three new Zod schemas exist and export inferred types; `SearchRun.stats` exposes the fuller shape; `npm run typecheck` and the contract check pass with no other file touched yet.

**Files:**
- Modify: `src/types/index.ts` (add schemas after `SearchRun` ~`:183`; widen `SearchRun.stats` ~`:174-178`)
- Test: `src/types/scanResult.test.ts` (new)

**Interfaces:**
- Consumes: `LegitimacyTier` (`types/index.ts:13`), `RunStatus` (`:157`), `Persona` (existing).
- Produces:
  - `ScanResult` / `type ScanResult`
  - `SearchRunSummary` / `type SearchRunSummary`
  - `ScanDetail` / `type ScanDetail`
  - widened `SearchRun.stats` object

- [ ] **Step 1: Write the failing schema test**

Create `src/types/scanResult.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ScanResult, SearchRunSummary, ScanDetail } from "./index";

describe("ScanResult", () => {
  it("accepts a scored row and rejects an unknown outcome", () => {
    const ok = ScanResult.parse({
      jobId: "j1", title: "Data Engineer", company: "Acme", source: "src-good",
      outcome: "scored", verdict: "Apply", legitimacyTier: "clear", fit: 4, scoredMs: 21000,
    });
    expect(ok.outcome).toBe("scored");
    expect(() => ScanResult.parse({ jobId: "j1", title: "t", company: "c", source: "s", outcome: "bogus" })).toThrow();
  });

  it("accepts a dailyCap skip and an error row", () => {
    expect(ScanResult.parse({ jobId: "j2", title: "t", company: "c", source: "s", outcome: "skipped", reason: "dailyCap" }).reason).toBe("dailyCap");
    expect(ScanResult.parse({ jobId: "j3", title: "t", company: "c", source: "s", outcome: "error", error: "boom" }).error).toBe("boom");
  });
});

describe("SearchRunSummary + ScanDetail", () => {
  const base = {
    id: "r1", status: "completed" as const, persona: "remote" as const,
    resumeName: "jane_v2.pdf", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    stats: { scanned: 40, matched: 30, scored: 28, worth: 6, ghosts: 2, unscored: 1, capStopped: false, discoverMs: 4200, scoreMs: 58000, costUsd: 0.42, policyVersion: "p3" },
  };
  it("summary parses; detail requires results[]", () => {
    expect(SearchRunSummary.parse(base).resumeName).toBe("jane_v2.pdf");
    expect(() => ScanDetail.parse(base)).toThrow(); // no results[]
    expect(ScanDetail.parse({ ...base, error: null, results: [] }).results).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/types/scanResult.test.ts`
Expected: FAIL — `ScanResult`/`SearchRunSummary`/`ScanDetail` are not exported.

- [ ] **Step 3: Add the schemas and widen `SearchRun.stats`**

In `src/types/index.ts`, first widen the inline `stats` object inside `SearchRun` (currently `:174-178`, `{ scanned, worth, ghosts }`) to the fuller wire shape. Replace that inner `stats: z.object({ … })` with a shared `ScanStats` schema declared just above `SearchRun`:

```ts
export const ScanStats = z.object({
  scanned: z.number().int(),
  matched: z.number().int(),
  scored: z.number().int(),
  worth: z.number().int(),
  ghosts: z.number().int(),
  unscored: z.number().int(),
  capStopped: z.boolean(),
  discoverMs: z.number().int(),
  scoreMs: z.number().int(),
  costUsd: z.number(),
  policyVersion: z.string(),
});
export type ScanStats = z.infer<typeof ScanStats>;
```

and change the `SearchRun` field to `stats: ScanStats,`. (This widens the `done` SSE payload and the JSON snapshot; `toSearchRun` is updated in Task 4 to supply every field.)

Then, immediately after the `SearchRun` block (~`:183`), add:

```ts
export const ScanResult = z.object({
  jobId: z.string(),
  title: z.string(),
  company: z.string(),
  source: z.string(),
  outcome: z.enum(["scored", "unscored", "error", "skipped"]),
  verdict: z.enum(["Apply", "Consider", "Research first", "Skip"]).optional(),
  legitimacyTier: LegitimacyTier.optional(),
  fit: z.number().min(0).max(5).optional(),
  scoredMs: z.number().int().optional(),
  reason: z.literal("dailyCap").optional(), // only when outcome === "skipped"
  error: z.string().optional(),             // only when outcome === "error"
});
export type ScanResult = z.infer<typeof ScanResult>;

export const SearchRunSummary = z.object({
  id: z.string(),
  status: RunStatus,
  persona: Persona,
  resumeName: z.string(), // joined from resumes at read time
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  stats: ScanStats,
});
export type SearchRunSummary = z.infer<typeof SearchRunSummary>;

export const ScanDetail = SearchRunSummary.extend({
  error: z.string().nullable(),
  results: z.array(ScanResult),
});
export type ScanDetail = z.infer<typeof ScanDetail>;
```

- [ ] **Step 4: Run the schema test to verify it passes**

Run: `npx vitest run src/types/scanResult.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck to surface the intentional break**

Run: `npx tsc --noEmit`
Expected: FAIL at `src/server/search/assemble-run.ts:24` — `toSearchRun` now under-supplies `stats` (only `scanned/worth/ghosts`). **Do not fix here** — Task 4 Step 6 rewrites `toSearchRun`. This confirmed break is the Task-1→Task-4 dependency; note it and proceed. (If executing tasks out of order, jump to Task 4 Step 6 before running the full gate.)

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts src/types/scanResult.test.ts
git commit -m "feat(types): ScanResult + SearchRunSummary + ScanDetail; widen ScanStats"
```

---

### Task 2: Migration + persisted `SearchRunStats` shape + `resumes.label` display name

**Model · effort · goal:** `executor` (sonnet) · medium · `search_runs` gains a `results` jsonb NOT NULL DEFAULT `'[]'` column, `resumes` gains a `label` text column (backfilled + written at upload/paste time so it is always non-null on read), and the internal `SearchRunStats` type carries `discoverMs`/`scoreMs`/`costUsd`/`policyVersion`; `npm run db:generate` emits one migration whose `resumes` backfill is filled in by hand; the PGlite test DB boots with both new columns.

> **B1 resolution (résumé display name):** the `resumes` table has **no** display-name column today (real columns: `rawText`, `structured`, `originalPath` nullable, `sourceKind`, `atsScore`, `isActive`). We add a dedicated **`resumes.label` text** column, backfill existing rows, and set it on every résumé write, so the M1 list/detail join reads a guaranteed-present name. This is the chosen option over deriving `basename(originalPath)` (null for pasted résumés) or a nullable `resumeName` — it keeps `SearchRunSummary.resumeName: z.string()` fail-loud with no per-consumer empty-state.

**Files:**
- Modify: `src/server/persistence/schema.ts` (`SearchRunStats` type ~`:44-54`; `searchRuns` table ~`:118-128`; `resumes` table ~`:101-116`)
- Modify: the résumé write path (upload + paste) — find it: `git grep -n "resumesRepo\|insert(resumes\|createResume" src/server` — to set `label` on create
- Create: `drizzle/00NN_<name>.sql` (hand-edit the `resumes.label` backfill) + `drizzle/meta/00NN_snapshot.json` + journal entry (generated)

**Interfaces:**
- Consumes: `jsonb`, `pgTable`, existing column builders (already imported in schema.ts).
- Produces: `searchRuns.results` column (`ScanResult[]` typed); extended `SearchRunStats` type consumed by the repo (Task 3) and `run.ts` (Task 4).

- [ ] **Step 1: Extend the internal `SearchRunStats` type**

In `src/server/persistence/schema.ts` (`:44-54`), extend the local type (keep `unscored?`/`capStopped?` optional to match existing rows written before M1; the new run engine always writes them):

```ts
type PerSourceStat = { sourceId: string; found: number; errors: number };
type SearchRunStats = {
  scanned: number;
  matched: number;
  scored: number;
  worth: number;
  ghosts: number;
  perSource: PerSourceStat[];
  unscored?: number;
  capStopped?: boolean;
  // M1 additions — real stage durations (ms) + accumulated cost + scoring policy id.
  discoverMs?: number;
  scoreMs?: number;
  costUsd?: number;
  policyVersion?: string;
};
```

- [ ] **Step 2: Add the `results` column and import the row type**

At the top of `src/server/persistence/schema.ts`, add an import for the wire result type (schema.ts already imports from `@/types` for other shapes; if not, add it):

```ts
import type { ScanResult } from "@/types";
```

Then in the `searchRuns` table (`:118-128`), add the column after `stats`:

```ts
  stats: jsonb("stats").$type<SearchRunStats>().notNull(),
  results: jsonb("results").$type<ScanResult[]>().notNull().default([]),
```

- [ ] **Step 2b: Add the `resumes.label` display-name column**

In the `resumes` table (`:101-116`), add a nullable text column (nullable at the DB level for the backfill/migration window; always written on create per Step 4b so reads are non-null):

```ts
  label: text("label"),
```

- [ ] **Step 3: Generate the migration + hand-write the résumé backfill**

Run: `npm run db:generate`
Expected: one new `drizzle/00NN_*.sql` with `ALTER TABLE "search_runs" ADD COLUMN "results" jsonb DEFAULT '[]'::jsonb NOT NULL;` **and** `ALTER TABLE "resumes" ADD COLUMN "label" text;`, plus the snapshot + `_journal.json` entry. (The `stats` jsonb shape change is type-only — no DDL.)

Then **hand-edit** the generated `.sql` to backfill existing résumé rows immediately after the `resumes` ADD COLUMN (drizzle-kit does not emit data migrations), so no historical row reads null:

```sql
--> statement-breakpoint
UPDATE "resumes" SET "label" = COALESCE(
  NULLIF(regexp_replace("original_path", '^.*/', ''), ''),  -- basename of the uploaded file
  "structured" ->> 'headline',                               -- pasted résumés: the parsed headline
  'Résumé ' || substr("id"::text, 1, 8)                      -- last-resort stable label
) WHERE "label" IS NULL;
```

(Confirm the physical column names — `original_path`, `structured` — with `git grep -n "original_path\|originalPath\|structured" drizzle/*.sql`; use whatever the snake_case migration names are.)

- [ ] **Step 4: Verify the migration diff**

Run: `git status --porcelain drizzle/`
Expected: one new `.sql` (the two ADD COLUMNs + the backfill UPDATE), one new snapshot, a modified `_journal.json`. Confirm no unrelated drift (delete + regenerate if so, then re-add the backfill).

- [ ] **Step 4b: Set `label` on every résumé write**

In the résumé write path (the upload route and the paste route — found via the Task-header grep), set `label` when inserting a résumé:

```ts
// uploaded file: use the original filename; pasted: use the parsed headline
label: originalFilename ?? structured.headline ?? null,
```

Fail loud only where a value is genuinely required elsewhere — here a null `label` is tolerated by the DB and immediately backfilled, and the read path (Task 3) coalesces to the headline, so no scan list row is ever nameless. Add/adjust a résumé-repo test asserting `label` is persisted on create.

- [ ] **Step 5: Confirm the test DB applies it**

Run: `npx vitest run src/server/persistence/repos/searchRuns.test.ts` (the existing suite that spins up PGlite from the schema)
Expected: PASS — the PGlite harness builds tables from `schema.ts`, so the `results` column is present; no new assertions yet, just proves the column doesn't break existing repo tests.

- [ ] **Step 6: Commit**

```bash
git add src/server/persistence/schema.ts drizzle/ src/server/persistence/repos
git commit -m "feat(db): search_runs.results jsonb + resumes.label (backfilled) + extended SearchRunStats"
```

---

### Task 3: Repo — `appendResult`, `listByUser`, `getDetail`

**Model · effort · goal:** `deep-thinker` (fable) · high · A status-fenced concurrent-safe `appendResult`, a paginated user-scoped `listByUser` with a résumé-name join, and a `getDetail` returning the full row incl. `results`; repo unit tests prove append accumulates under interleaved writes, pagination is stable, and scoping excludes other users.

**Files:**
- Modify: `src/server/persistence/repos/searchRuns.ts` (add three methods to the factory + singleton)
- Test: `src/server/persistence/repos/searchRuns.test.ts` (add cases)

> **Test-DB fixture note:** `searchRuns.test.ts` creates its DB per test via `const db = await createTestDb()` (the `state.testDb` pattern shown below belongs to `run.test.ts`). Match whatever the *real* file uses — read its top-of-file setup before writing, and bind the repo to that db handle.

**Interfaces:**
- Consumes: `and, desc, eq, sql, lt` from `drizzle-orm`; `searchRuns`, `resumes` tables; `SearchRunRow` (`:8`).
- Produces:
  - `appendResult(runId: string, userId: string, result: ScanResult): Promise<void>`
  - `listByUser(userId: string, opts?: { limit?: number; cursor?: string }): Promise<{ items: SearchRunSummaryRow[]; nextCursor: string | null }>`
  - `getDetail(id: string, userId: string): Promise<(SearchRunRow & { resumeName: string }) | null>`
  - type `SearchRunSummaryRow = Pick<SearchRunRow, "id"|"status"|"personas"|"stats"|"startedAt"|"finishedAt"|"error"> & { resumeName: string }`

- [ ] **Step 1: Write the failing repo tests**

In `src/server/persistence/repos/searchRuns.test.ts`, add (reuse the file's existing `state.testDb`, `insertResume`, `insertSearchRun`/insert helpers; if a helper is missing, insert via `repo.insert(...)`):

```ts
  it("appendResult accumulates under interleaved concurrent writes (status-fenced)", async () => {
    const repo = createSearchRunsRepo(state.testDb);
    const resume = await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const run = await repo.insert({
      userId: BOOTSTRAP_ADMIN_ID, resumeId: resume.id, personas: ["remote"],
      status: "running", stats: baseStatsFixture, results: [],
    });
    const mk = (n: number) => ({ jobId: `j${n}`, title: `T${n}`, company: `C${n}`, source: "s", outcome: "scored" as const, verdict: "Apply" as const, fit: 4, scoredMs: 1000 });
    await Promise.all([1, 2, 3, 4, 5].map((n) => repo.appendResult(run.id, BOOTSTRAP_ADMIN_ID, mk(n))));
    const detail = await repo.getDetail(run.id, BOOTSTRAP_ADMIN_ID);
    expect(detail?.results).toHaveLength(5);
    expect(new Set(detail!.results.map((r) => r.jobId))).toEqual(new Set(["j1", "j2", "j3", "j4", "j5"]));
  });

  it("appendResult is a no-op once the run is terminal (status fence)", async () => {
    const repo = createSearchRunsRepo(state.testDb);
    const resume = await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const run = await repo.insert({ userId: BOOTSTRAP_ADMIN_ID, resumeId: resume.id, personas: ["remote"], status: "completed", stats: baseStatsFixture, results: [] });
    await repo.appendResult(run.id, BOOTSTRAP_ADMIN_ID, { jobId: "late", title: "t", company: "c", source: "s", outcome: "scored" });
    const detail = await repo.getDetail(run.id, BOOTSTRAP_ADMIN_ID);
    expect(detail?.results).toHaveLength(0);
  });

  it("listByUser paginates newest-first, scopes to the user, and joins the résumé label", async () => {
    const repo = createSearchRunsRepo(state.testDb);
    await insertUser(state.testDb, { id: OTHER_USER_ID }); // FK: search_runs.user_id → users.id (PGlite enforces it)
    const mine = await insertResume(state.testDb, { ...resumeFixture, isActive: true, label: "mine.pdf" });
    for (let i = 0; i < 3; i++) {
      await repo.insert({ userId: BOOTSTRAP_ADMIN_ID, resumeId: mine.id, personas: ["remote"], status: "completed", stats: baseStatsFixture, results: [], startedAt: new Date(2026, 0, i + 1) });
    }
    await repo.insert({ userId: OTHER_USER_ID, resumeId: mine.id, personas: ["remote"], status: "completed", stats: baseStatsFixture, results: [], startedAt: new Date(2026, 0, 9) });

    const page1 = await repo.listByUser(BOOTSTRAP_ADMIN_ID, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.items[0].resumeName).toBe("mine.pdf");
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await repo.listByUser(BOOTSTRAP_ADMIN_ID, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(1); // 3 mine total, other user's row excluded
    expect(page2.nextCursor).toBeNull();
  });
```

Add `OTHER_USER_ID` + a `baseStatsFixture` near the top of the test file if absent, and an `insertUser` helper (or reuse the file's existing one — check its imports):

```ts
const OTHER_USER_ID = "00000000-0000-0000-0000-0000000000ff";
const baseStatsFixture = { scanned: 0, matched: 0, scored: 0, worth: 0, ghosts: 0, perSource: [] as { sourceId: string; found: number; errors: number }[] };
```

The display name comes from the new **`resumes.label`** column (Task 2). `insertResume`'s fixture accepts `label` (it's `Partial<typeof resumes.$inferInsert>`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/server/persistence/repos/searchRuns.test.ts -t "appendResult|listByUser"`
Expected: FAIL — the three methods don't exist.

- [ ] **Step 3: Implement the three methods**

In `src/server/persistence/repos/searchRuns.ts`, add `sql` and `lt` to the drizzle import (`:1`), import `resumes` from `../schema`, and add these to the factory object (before the closing `}` of `createSearchRunsRepo`'s return), then expose them on the `searchRunsRepo` singleton the same way the existing methods are:

```ts
    // Append one settled ScanResult to results[] via a jsonb concat, fenced on
    // status='running' so a terminal run can never grow. Postgres row-locks the
    // UPDATE, serializing the concurrent pool tasks — no lost writes. User-scoped.
    async appendResult(runId: string, userId: string, result: ScanResult): Promise<void> {
      await db
        .update(searchRuns)
        .set({ results: sql`${searchRuns.results} || ${JSON.stringify([result])}::jsonb` })
        .where(and(eq(searchRuns.id, runId), eq(searchRuns.userId, userId), eq(searchRuns.status, "running")));
    },

    async listByUser(
      userId: string,
      opts?: { limit?: number; cursor?: string },
    ): Promise<{ items: SearchRunSummaryRow[]; nextCursor: string | null }> {
      const limit = Math.min(opts?.limit ?? 20, 50);
      const rows = await db
        .select({
          id: searchRuns.id, status: searchRuns.status, personas: searchRuns.personas,
          stats: searchRuns.stats, startedAt: searchRuns.startedAt, finishedAt: searchRuns.finishedAt,
          error: searchRuns.error,
          // resumes.label is backfilled + written-on-create (Task 2); coalesce to the
          // parsed headline only as a belt-and-braces guard so the string is never null.
          resumeName: sql<string>`COALESCE(${resumes.label}, ${resumes.structured} ->> 'headline', 'Résumé')`,
        })
        .from(searchRuns)
        .innerJoin(resumes, eq(searchRuns.resumeId, resumes.id))
        .where(
          opts?.cursor
            ? and(eq(searchRuns.userId, userId), lt(searchRuns.startedAt, new Date(opts.cursor)))
            : eq(searchRuns.userId, userId),
        )
        .orderBy(desc(searchRuns.startedAt))
        .limit(limit + 1);
      const items = rows.slice(0, limit);
      const nextCursor = rows.length > limit ? items[items.length - 1].startedAt.toISOString() : null;
      return { items, nextCursor };
    },

    async getDetail(id: string, userId: string): Promise<(SearchRunRow & { resumeName: string }) | null> {
      const [row] = await db
        .select({ run: searchRuns, resumeName: sql<string>`COALESCE(${resumes.label}, ${resumes.structured} ->> 'headline', 'Résumé')` })
        .from(searchRuns)
        .innerJoin(resumes, eq(searchRuns.resumeId, resumes.id))
        .where(and(eq(searchRuns.id, id), eq(searchRuns.userId, userId)))
        .limit(1);
      return row ? { ...row.run, resumeName: row.resumeName } : null;
    },
```

Add the row type near the top type aliases (`:7-8`):

```ts
export type SearchRunSummaryRow = Pick<SearchRunRow, "id" | "status" | "personas" | "stats" | "startedAt" | "finishedAt" | "error"> & { resumeName: string };
```

and `import type { ScanResult } from "@/types";`.

> **Cursor note:** the cursor is `startedAt` ISO; `startedAt` has second/ms resolution from `defaultNow()`, so ties are possible only for rows inserted in the same ms — acceptable for a per-user scan list. If a strict tiebreak is ever needed, promote the cursor to `(startedAt,id)`; not now (YAGNI).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/server/persistence/repos/searchRuns.test.ts`
Expected: PASS — append accumulates to 5, terminal append is a no-op, pagination returns 2 then 1 with the other user excluded.

- [ ] **Step 5: Commit**

```bash
git add src/server/persistence/repos/searchRuns.ts src/server/persistence/repos/searchRuns.test.ts
git commit -m "feat(repo): searchRuns.appendResult (fenced) + listByUser (paginated, scoped) + getDetail"
```

---

### Task 4: Wire incremental writes + partial-fail persistence into `run.ts`

**Model · effort · goal:** `deep-thinker` (fable) · high · Every settling job in the M0 rolling pool appends its `ScanResult`; discover/score wall-durations and accumulated `costUsd` land in `stats`; `failRun` persists accumulated stats + whatever `results` were written; `toSearchRun` supplies the widened `stats`; the run suite proves incremental persistence and partial-failure retention.

**Files:**
- Modify: `src/server/search/run.ts` (`scoreTopCandidates` pool callback ~`:463-515`; stats assembly ~`:273-296`; `failRun` ~`:161-180`; stage-duration capture at boundaries ~`:266/269`)
- Modify: `src/server/search/assemble-run.ts` (`toSearchRun` ~`:12-29`)
- Test: `src/server/search/run.test.ts` (add incremental-persist + partial-fail cases)

**Interfaces:**
- Consumes: `searchRunsRepo.appendResult` (Task 3), `scoreJob` result (`{ verdict, legitimacy, fit, costUsd }`), `ScanResult` (`@/types`), `Date.now()`.
- Produces: no signature change to `scoreTopCandidates`'s return; `stats` object now includes `discoverMs/scoreMs/costUsd/policyVersion`; `failRun` writes stats.

- [ ] **Step 1: Write the failing incremental-persist test**

In `src/server/search/run.test.ts`, add inside `describe("startSearch", …)`:

```ts
  it("persists a ScanResult per settled candidate incrementally + records stage durations and cost", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });
    const postings: RawPosting[] = [
      { sourceId: good.id, url: "https://example.com/jobs/a", title: "Data Engineer", company: "Acme", location: "Remote", description: "Build data pipelines with SQL." },
      { sourceId: good.id, url: "https://example.com/jobs/b", title: "Data Engineer", company: "Beta", location: "Remote", description: "More SQL pipelines." },
    ];
    const run = await startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote" }, { llm: costingLlm, connectorForSource: (s) => stubConnector(s, postings) });
    const finalRow = await waitForTerminal(runsRepo, run.id);

    expect(finalRow.status).toBe("completed");
    expect(finalRow.results).toHaveLength(2);
    expect(finalRow.results.every((r) => r.outcome === "scored")).toBe(true);
    expect(finalRow.results[0]).toMatchObject({ company: expect.any(String), verdict: expect.any(String), source: good.id });
    expect(typeof finalRow.results[0].scoredMs).toBe("number");
    expect(finalRow.stats.discoverMs).toBeGreaterThanOrEqual(0);
    expect(finalRow.stats.scoreMs).toBeGreaterThanOrEqual(0);
    expect(finalRow.stats.costUsd).toBeCloseTo(0.04, 5); // costingLlm charges 0.02/job × 2
    expect(typeof finalRow.stats.policyVersion).toBe("string");
  });
```

- [ ] **Step 2: Write the failing partial-fail test**

```ts
  it("failRun persists accumulated stats + partial results when the run crashes mid-scoring", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });
    const postings: RawPosting[] = [
      { sourceId: good.id, url: "https://example.com/jobs/a", title: "Data Engineer", company: "Acme", location: "Remote", description: "Build data pipelines with SQL." },
    ];
    // scoreOnceThenThrow: first job scores, then the repo write path is poisoned to force runFanOut into failRun.
    const run = await startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote" }, { llm: costingLlm, connectorForSource: (s) => stubConnector(s, postings), afterScoring: () => { throw new Error("boom"); } });
    const finalRow = await waitForTerminal(runsRepo, run.id);

    expect(finalRow.status).toBe("failed");
    expect(finalRow.error).toContain("boom");
    expect(finalRow.results).toHaveLength(1);           // the job that settled before the crash
    expect(finalRow.stats.scored).toBe(1);              // accumulated, not zeroed
  });
```

This introduces a tiny test-only `afterScoring?: () => void` hook on `StartSearchDeps`, called once after `scoreTopCandidates` returns and before the completion writes — the minimal seam to force a mid-run throw deterministically. (If a crash can already be induced via an existing dep, use that instead and drop the hook.)

- [ ] **Step 2b: Write the failing cap-hit persistence test (spec §5/§6)**

Reuse M0's deterministic cap setup (`scoreConcurrency: 1`, `dailyCapUsd: 0.025`, 4 postings → 2 score then the gate bails) and assert the skipped candidates are persisted as `skipped:dailyCap` result rows:

```ts
  it("cap-hit run persists skipped:dailyCap result rows for the un-scored top candidates", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });
    const postings: RawPosting[] = [1, 2, 3, 4].map((n) => ({
      sourceId: good.id, url: `https://example.com/jobs/cap-${n}`, title: "Data Engineer",
      company: `Co${n}`, location: "Remote", description: "Build data pipelines with SQL.",
    }));
    const run = await startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote" },
      { llm: costingLlm, dailyCapUsd: 0.025, scoreConcurrency: 1, connectorForSource: (s) => stubConnector(s, postings) });
    const finalRow = await waitForTerminal(runsRepo, run.id);

    expect(finalRow.status).toBe("completed");
    expect(finalRow.stats.capStopped).toBe(true);
    const scored = finalRow.results.filter((r) => r.outcome === "scored");
    const skipped = finalRow.results.filter((r) => r.outcome === "skipped" && r.reason === "dailyCap");
    expect(scored).toHaveLength(2);
    expect(skipped).toHaveLength(2); // the 2 candidates the gate bailed on are recorded, not dropped
  });
```

- [ ] **Step 3: Run all three to verify they fail**

Run: `npx vitest run src/server/search/run.test.ts -t "incrementally|failRun persists accumulated|cap-hit run persists"`
Expected: FAIL — `finalRow.results` is `[]` (no append wired), `stats.costUsd`/`discoverMs` undefined, the crashed run shows `scored: 0`, and the cap-hit run records no `skipped` rows.

- [ ] **Step 4: Capture stage durations at the boundaries**

In `src/server/search/run.ts`, inside `runFanOut`, stamp the discovery start right before the discovery `handle.emit(stage:"sources")` (~`:213`) and close both spans around scoring. Concretely:

```ts
  const discoverStartedAt = Date.now();
  // … existing discovery tasks …
  await Promise.all(tasks);               // ~:266
  const discoverMs = Date.now() - discoverStartedAt;

  const upsertedJobs = await upsertMatchedPostings(userId, matchedPostings, persona, profile); // :268
  const scoreStartedAt = Date.now();
  const { scored, worth, ghosts, unscored, capStopped, costUsd } = await scoreTopCandidates(
    userId, row, upsertedJobs, resumeRow, persona, profile, handle, deps,
  );
  const scoreMs = Date.now() - scoreStartedAt;
```

(`scoreTopCandidates` must now also return `costUsd` — Step 5.)

- [ ] **Step 5: Append a ScanResult per settled job + accumulate cost in the pool**

In `scoreTopCandidates`, add `let spentCost = 0;` next to the other counters (~`:435`) and, in the pool callback (`:463-515`), append a result on each terminal branch. Replace the callback body's success/catch/finally region with:

```ts
        if (handle.signal.aborted) return;
        if (dailyCapUsd !== undefined && spentToday >= dailyCapUsd) {
          if (!capStopped) console.error(`search run ${row.id}: daily cost cap reached; skipping remaining candidates`);
          capStopped = true;
          await searchRunsRepo.appendResult(row.id, userId, {
            jobId: job.id, title: job.title, company: job.company, source: source.id,
            outcome: "skipped", reason: "dailyCap",
          });
          return;
        }
        const jobStartedAt = Date.now();
        try {
          const jobToScore = await ensureDescription(job, source).catch((err) => {
            console.error(`search run ${row.id}: detail fetch for job ${job.id} failed:`, err);
            return job;
          });
          const scoreRow = await scoreJob({ job: jobToScore, source, profile, resume, llm, signal: handle.signal });
          spentToday += scoreRow.costUsd;
          spentCost += scoreRow.costUsd;
          scored += 1;
          if (scoreRow.verdict === "Apply" || scoreRow.verdict === "Consider") worth += 1;
          if (scoreRow.legitimacy.tier === "ghost") ghosts += 1;
          handle.emit({ event: "job", data: assembleJob({ job, score: scoreRow, source }, { isNewCutoff }) });
          await searchRunsRepo.appendResult(row.id, userId, {
            jobId: job.id, title: jobToScore.title, company: jobToScore.company, source: source.id,
            outcome: "scored", verdict: scoreRow.verdict, legitimacyTier: scoreRow.legitimacy.tier,
            fit: scoreRow.score, scoredMs: Date.now() - jobStartedAt, // NB: numeric fit is `score`; `scoreRow.fit` is a jsonb FitEntry[]
          });
        } catch (err) {
          if (err instanceof EmptyJobDescriptionError) {
            unscored += 1;
            await searchRunsRepo.appendResult(row.id, userId, {
              jobId: job.id, title: job.title, company: job.company, source: source.id, outcome: "unscored",
            });
          } else {
            console.error(`search run ${row.id}: scoring job ${job.id} failed:`, err);
            await searchRunsRepo.appendResult(row.id, userId, {
              jobId: job.id, title: job.title, company: job.company, source: source.id,
              outcome: "error", error: err instanceof Error ? err.message : String(err),
            });
          }
        } finally {
          doneCount += 1;
          handle.emit({ event: "progress", data: { stage: "score", current: doneCount, total: topCandidates.length, label: `${doneCount}/${topCandidates.length} scored` } });
        }
```

Then change the return (`:522`) and the empty-early-return (`:437`) to include cost:

```ts
  return { scored, worth, ghosts, unscored, capStopped, costUsd: spentCost };
```

and widen the return type in the signature (`:410-419`) to add `costUsd: number`.

> **Numeric fit field (verified):** on `JobScoreRow` the numeric 0–5 fit is **`score`** (`schema.ts:172`, `numeric(3,1)`); the field literally named `fit` is a **jsonb `FitEntry[]`** (`schema.ts:179`) — do not use it here. The `ScanResult.fit` wire field is populated from `scoreRow.score`. Fail loud — do not default to 0.

- [ ] **Step 6: Assemble the widened stats + rewrite `toSearchRun`**

Replace the `stats` object in `runFanOut` (the completion-path assembly, ~`:280-289`) with:

```ts
    const stats = {
      scanned,
      matched: matchedPostings.length,
      scored, worth, ghosts,
      perSource: [...perSource.entries()].map(([sourceId, s]) => ({ sourceId, found: s.found, errors: s.errors })),
      unscored, capStopped,
      discoverMs, scoreMs, costUsd,
      policyVersion: policyVersion("match-score"),
    };
```

`policyVersion` is a **function** — `policyVersion(task)` from `src/lib/llm/templates.ts:79`, already called as `policyVersion("match-score")` at `score/index.ts:129`. Import it; there is no `POLICY_VERSION` constant. `job_scores` is `UNIQUE(jobId, resumeId, policyVersion)`, so the same value keys both the verdict cache and the scan's recorded policy.

In `src/server/search/assemble-run.ts`, rewrite `toSearchRun`'s `stats` mapping (`:24`) to pass every `ScanStats` field, reading defaults only for legacy rows that predate M1 (these are the *only* permitted fallbacks — for historical DB rows, not live values):

```ts
    stats: {
      scanned: row.stats.scanned,
      matched: row.stats.matched,
      scored: row.stats.scored,
      worth: row.stats.worth,
      ghosts: row.stats.ghosts,
      unscored: row.stats.unscored ?? 0,
      capStopped: row.stats.capStopped ?? false,
      discoverMs: row.stats.discoverMs ?? 0,
      scoreMs: row.stats.scoreMs ?? 0,
      costUsd: row.stats.costUsd ?? 0,
      policyVersion: row.stats.policyVersion ?? "legacy",
    },
```

- [ ] **Step 7: Hoist accumulators, then make the catch persist partial stats**

The blocker (fatal if skipped): a `catch` clause **cannot see variables declared inside its `try`**. In the real `run.ts` the `try` opens at `:201` and `perSource` (`:206`), `matchedPostings` (`:209`), `scanned` (`:210`), plus Step 4's `discoverMs`/`scoreMs` and the destructured `scored/worth/ghosts/unscored/capStopped/costUsd`, are all declared **inside** it. So first **hoist every accumulator and stage timestamp above the `try`** (between the `hardCapTimer` at `:199` and `try {` at `:201`), and assign into them in the body instead of re-declaring:

```ts
  const hardCapTimer = setTimeout(() => handle.abort("hard runtime cap exceeded"), hardRunTimeoutMs);

  // Hoisted so the partial-persist catch below can read the last known values.
  const perSource = new Map<string, { found: number; errors: number }>();
  let scanned = 0;
  let matchedPostings: MatchedPosting[] = [];
  let discoverMs = 0, scoreMs = 0;
  let scored = 0, worth = 0, ghosts = 0, unscored = 0, costUsd = 0;
  let capStopped = false;

  try {
    // …discovery assigns scanned / matchedPostings / perSource and discoverMs…
    // …scoring assigns ({ scored, worth, ghosts, unscored, capStopped, costUsd } = await scoreTopCandidates(...)) and scoreMs…
    // …completion writes (Step 6)…
  } catch (err) {
    // Partial-run persistence (M1): write whatever counters accumulated before the
    // crash so the failed run isn't zeroed. results[] was appended incrementally
    // per job (Step 5), so it already survives untouched.
    try {
      await searchRunsRepo.updateStats(row.id, {
        scanned, matched: matchedPostings.length, scored, worth, ghosts,
        perSource: [...perSource.entries()].map(([sourceId, s]) => ({ sourceId, found: s.found, errors: s.errors })),
        unscored, capStopped, discoverMs, scoreMs, costUsd, policyVersion: policyVersion("match-score"),
      });
    } catch (statsErr) {
      console.error(`search run ${row.id}: failed to persist partial stats before failRun:`, statsErr);
    }
    throw err; // re-throw to the existing startSearch .catch → failRun (status+error+emit)
  } finally {
    clearTimeout(hardCapTimer);
  }
```

Change the body's `const perSource = …`, `let scanned = …`, `const/let matchedPostings = …`, `const { scored, … } = await scoreTopCandidates(...)` etc. into plain assignments to the hoisted bindings (drop the `const`/`let`/destructure-`const`). For a crash *before* scoring, the values are legitimately their initial `0`/`false` — the true state. `failRun` itself (`:161-180`) is unchanged. (Confirm the `MatchedPosting` type name via `git grep -n "matchedPostings" src/server/search/run.ts` and import if the hoisted `let` needs an annotation.)

- [ ] **Step 8: Run the run suite to verify green**

Run: `npx vitest run src/server/search/run.test.ts`
Expected: PASS — incremental test sees `results.length === 2` + durations + `costUsd ≈ 0.04`; partial-fail test sees `status:"failed"`, `results.length === 1`, `scored === 1`; all pre-existing M0 tests (rolling pool, per-job cap gate, hard-cap-covers-scoring) still green.

- [ ] **Step 9: Commit**

```bash
git add src/server/search/run.ts src/server/search/assemble-run.ts src/server/search/run.test.ts
git commit -m "feat(search): incremental ScanResult persistence + stage durations/cost + partial-fail stats"
```

---

### Task 5: API — run list + detail JSON

**Model · effort · goal:** `executor` (sonnet) · medium · `GET /api/search` returns a user-scoped paginated `SearchRunSummary[]`; `GET /api/search/:id` in JSON mode returns `ScanDetail` (incl. `results` + widened `stats`); route tests prove auth, scoping (foreign id → 404), and pagination.

**Files:**
- Modify: `src/app/api/search/route.ts` (add a `GET` export alongside the existing `POST`)
- Modify: `src/app/api/search/[id]/route.ts` (JSON-snapshot branch ~`:46-49` → return `ScanDetail`)
- Create: `src/server/search/assemble-summary.ts` (`toSearchRunSummary`, `toScanDetail`)
- Test: `src/app/api/search/route.test.ts` + `src/app/api/search/[id]/route.test.ts` (add cases)

**Interfaces:**
- Consumes: `searchRunsRepo.listByUser` / `getDetail` (Task 3), `requireUser`, `SearchRunSummary` / `ScanDetail` (Task 1).
- Produces:
  - `toSearchRunSummary(row: SearchRunSummaryRow): SearchRunSummary`
  - `toScanDetail(row: SearchRunRow & { resumeName: string }): ScanDetail`
  - `GET /api/search?limit&cursor` → `{ items: SearchRunSummary[]; nextCursor: string | null }`
  - `GET /api/search/:id` (JSON) → `ScanDetail`

- [ ] **Step 1: Write the failing assembler + tests**

Create `src/server/search/assemble-summary.ts`:

```ts
import type { SearchRunRow, SearchRunSummaryRow } from "@/server/persistence/repos/searchRuns";
import { SearchRunSummary, ScanDetail, type SearchRunSummary as TSummary, type ScanDetail as TDetail } from "@/types";

function personaOf(personas: SearchRunRow["personas"], id: string): "remote" | "local" {
  const p = personas[0];
  if (!p) throw new Error(`search_runs row ${id} has an empty personas[] — cannot derive the wire persona`);
  return p;
}

function statsOf(s: SearchRunRow["stats"]) {
  return {
    scanned: s.scanned, matched: s.matched, scored: s.scored, worth: s.worth, ghosts: s.ghosts,
    unscored: s.unscored ?? 0, capStopped: s.capStopped ?? false,
    discoverMs: s.discoverMs ?? 0, scoreMs: s.scoreMs ?? 0, costUsd: s.costUsd ?? 0,
    policyVersion: s.policyVersion ?? "legacy",
  };
}

export function toSearchRunSummary(row: SearchRunSummaryRow): TSummary {
  return SearchRunSummary.parse({
    id: row.id, status: row.status, persona: personaOf(row.personas, row.id), resumeName: row.resumeName,
    startedAt: row.startedAt.toISOString(), finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    stats: statsOf(row.stats),
  });
}

export function toScanDetail(row: SearchRunRow & { resumeName: string }): TDetail {
  return ScanDetail.parse({
    id: row.id, status: row.status, persona: personaOf(row.personas, row.id), resumeName: row.resumeName,
    startedAt: row.startedAt.toISOString(), finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    stats: statsOf(row.stats), error: row.error ?? null, results: row.results,
  });
}
```

Add to `src/app/api/search/route.test.ts`:

```ts
  it("GET /api/search returns the caller's runs newest-first, paginated", async () => {
    // seed 2 completed runs for the authed user via the repo, then:
    const res = await GET(new NextRequest("http://x/api/search?limit=1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].resumeName).toBeDefined();
    expect(body.nextCursor).not.toBeNull();
  });
```

(Follow the existing test file's auth-mock + seed helpers; if the suite stubs `requireUser`, reuse that stub.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/app/api/search/route.test.ts -t "GET /api/search returns"`
Expected: FAIL — no `GET` export.

- [ ] **Step 3: Add the `GET` list handler**

In `src/app/api/search/route.ts`, add (mirroring the existing `POST`'s auth/error mapping):

```ts
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireUser();
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    if (limitRaw !== null && (!Number.isInteger(limit) || limit! < 1)) {
      return errorResponse("VALIDATION_ERROR", "limit must be a positive integer", 422);
    }
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const page = await searchRunsRepo.listByUser(session.id, { limit, cursor });
    return NextResponse.json({ items: page.items.map(toSearchRunSummary), nextCursor: page.nextCursor }, { status: 200 });
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse("UNAUTHORIZED", err.message, 401);
    throw err;
  }
}
```

Add imports: `searchRunsRepo`, `toSearchRunSummary`, and the existing `errorResponse` helper (find it: `git grep -n "errorResponse\|ErrorCode" src/app/api src/types`). Use `"VALIDATION_ERROR"` / `"UNAUTHORIZED"` from the typed `ErrorCode` enum (`types/index.ts:258-273`) — `"BAD_REQUEST"` is **not** a member and must not be introduced.

- [ ] **Step 4: Widen the `[id]` JSON snapshot to `ScanDetail`**

In `src/app/api/search/[id]/route.ts`, the ownership read at `:41` uses `getById`; switch it to `getDetail` (which also returns `resumeName`), and change the non-SSE branch (`:46-49`) from `toSearchRun(row)` to `toScanDetail(row)`:

```ts
    const row = await searchRunsRepo.getDetail(id, session.id);
    if (!row) return NextResponse.json({ error: { code: "NOT_FOUND", message: "run not found" } }, { status: 404 });
    // …
    if (!acceptsSse) return NextResponse.json(toScanDetail(row), { status: 200 });
```

The SSE branch still needs a plain `SearchRunRow` for its terminal-synthesis `toSearchRun(row)` calls — `getDetail`'s return is a superset (`SearchRunRow & { resumeName }`), so those calls keep compiling unchanged. Add the `toScanDetail` import.

> **B3 note (owned by Task 6):** the JSON snapshot now returns `ScanDetail`, which drops `sources`/`progress`, so `client.ts`'s `getSearchRun` (`SearchRun.parse`) and its callers (incl. `spine.test.ts:196-197`) would throw a runtime ZodError. That `client.ts` + `spine.test` migration is done in **Task 6 Step 3b** — kept out of this task so Tasks 5 and 6 never edit `client.ts` concurrently. This task only changes the route's return type; it must not touch `client.ts`.

- [ ] **Step 5: Add the detail route test**

In `src/app/api/search/[id]/route.test.ts`:

```ts
  it("GET /api/search/:id (JSON) returns ScanDetail with results[] for the owner", async () => {
    // seed a completed run with 2 results for the authed user
    const res = await GET(new NextRequest("http://x/api/search/" + runId, { headers: { accept: "application/json" } }), { params: Promise.resolve({ id: runId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(2);
    expect(body.stats.costUsd).toBeDefined();
  });
```

- [ ] **Step 6: Run the route suites + verify pass**

Run: `npx vitest run src/app/api/search/route.test.ts src/app/api/search/[id]/route.test.ts`
Expected: PASS — list returns paginated summaries; detail returns `ScanDetail` with `results` + `stats.costUsd`; the existing 401/404/SSE tests still green.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/search/route.ts "src/app/api/search/[id]/route.ts" src/server/search/assemble-summary.ts src/app/api/search/route.test.ts "src/app/api/search/[id]/route.test.ts"
git commit -m "feat(api): GET /api/search list + ScanDetail JSON snapshot"
```

---

### Task 6: `features/search/client` typed readers

**Model · effort · goal:** `executor` (sonnet) · low · `listScans` and `getScanDetail` fetch the new endpoints and return Zod-parsed `SearchRunSummary[]` / `ScanDetail`; a unit test proves parsing.

**Files:**
- Modify: `src/features/search/client.ts` (add two functions next to `startSearch`/`getSearchRun` ~`:12-22`)
- Test: `src/features/search/client.test.ts` (add cases; or create if absent)

**Interfaces:**
- Consumes: `SearchRunSummary`, `ScanDetail` (`@/types`).
- Produces:
  - `listScans(opts?: { limit?: number; cursor?: string }): Promise<{ items: SearchRunSummary[]; nextCursor: string | null }>`
  - `getScanDetail(id: string): Promise<ScanDetail>`

- [ ] **Step 1: Write the failing test** (mock `fetch`, assert parsed shape). Follow the pattern the existing `client.test.ts` uses for `getSearchRun`.

- [ ] **Step 2: Run → FAIL** (`listScans` not exported).

- [ ] **Step 3: Implement**

```ts
export async function listScans(opts?: { limit?: number; cursor?: string }): Promise<{ items: SearchRunSummary[]; nextCursor: string | null }> {
  const qs = new URLSearchParams();
  if (opts?.limit) qs.set("limit", String(opts.limit));
  if (opts?.cursor) qs.set("cursor", opts.cursor);
  const res = await fetch(`/api/search${qs.toString() ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`listScans failed: ${res.status}`);
  const body = await res.json();
  return { items: z.array(SearchRunSummary).parse(body.items), nextCursor: (body.nextCursor ?? null) as string | null };
}

export async function getScanDetail(id: string): Promise<ScanDetail> {
  const res = await fetch(`/api/search/${id}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`getScanDetail failed: ${res.status}`);
  return ScanDetail.parse(await res.json());
}
```

Add `SearchRunSummary, ScanDetail` (and `z`) to the imports.

- [ ] **Step 3b: Retire `getSearchRun` and repoint its callers (B3)**

The `[id]` JSON snapshot now returns `ScanDetail` (Task 5), so `getSearchRun`'s `SearchRun.parse` would throw. Find every caller — `git grep -n "getSearchRun" src` — repoint each to `getScanDetail` (which exposes the `status`/`stats` they read), and delete `getSearchRun`. Notably `src/app/spine.test.ts:196-197` polls terminal status through it. If any JSON-path caller genuinely needs `sources`/`progress` (grep shows none — those are live-only), stop and reconcile before deleting. This task owns `client.ts`, so this edit lives here, not in Task 5.

- [ ] **Step 4: Run → PASS** (client unit test + the repointed `spine.test`). `npx vitest run src/features/search/client.test.ts src/app/spine.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/features/search/client.ts src/features/search/client.test.ts src/app/spine.test.ts
git commit -m "feat(search): listScans + getScanDetail readers; retire getSearchRun (B3)"
```

---

### Task 7: Nav item — "Scans" under Pipeline

**Model · effort · goal:** `executor` (sonnet) · low · A "Scans" entry renders under the Pipeline section and, when selected, routes to `/scans`; the sidebar dom/story test stays green and the id→route map covers `scans`.

**Files:**
- Modify: `src/caliber-ui/compositions/Shell/AppSidebar.tsx` (`SIDEBAR_ITEMS` ~`:11-33`; `DEFAULT_ENABLED` ~`:33`)
- Modify: the shell layout that maps nav id → route (find it: `git grep -n "SIDEBAR_ITEMS\|onSelect" src/app src/caliber-ui | grep -v stories`) — likely `src/app/AppShell.tsx`
- Test: `src/caliber-ui/compositions/Shell/AppSidebar.dom.test.tsx` (or the existing sidebar test)

**Interfaces:**
- Consumes: `NavItem` (`SidebarNav.tsx:5`, fields `{ id, label, icon, section }` — no `href`/`disabled`).
- Produces: nav id `"scans"` → route `/scans`.

- [ ] **Step 1:** Add a `scans` entry to `SIDEBAR_ITEMS` under the Pipeline section (between `applied` and `interviews`), and to `DEFAULT_ENABLED`:

```ts
  { id: "matches", label: "Matches", icon: "target" },
  { id: "applied", label: "Applied", icon: "circle-check" },
  { id: "scans", label: "Scans", icon: "activity" },
  { id: "interviews", label: "Interviews", icon: "users" },
```
```ts
export const DEFAULT_ENABLED = new Set(["matches", "applied", "scans", "resume", "sources", "profile"]);
```

> Use **`"activity"`** (spec §9's option, confirmed present in `Icon.tsx:55`). Do **not** use `"radar"` — that's already Sources' glyph (`AppSidebar.tsx:21`) — and `"history"` is absent from the `ICONS` map (unknown names warn + fall back to `Circle`).

- [ ] **Step 2:** In the shell layout's id→route switch, add the `scans` case (mirror how `matches → /feed`, `applied → /tracker` are wired — same file, same map). Add both directions if `activeId` is derived from the pathname.

- [ ] **Step 3:** Extend the sidebar test to assert a "Scans" row renders and its `onSelect("scans")` routes to `/scans`. Run: `npx vitest run src/caliber-ui/compositions/Shell/AppSidebar.dom.test.tsx` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/caliber-ui/compositions/Shell/AppSidebar.tsx src/app/AppShell.tsx src/caliber-ui/compositions/Shell/AppSidebar.dom.test.tsx
git commit -m "feat(nav): Scans item under Pipeline → /scans"
```

---

### Task 8: `/scans` list page + `ScansList` composition + launcher

**Model · effort · goal:** `executor` (sonnet) · medium · `/scans` renders each run as a card (résumé name, relative time, duration, verdict mix, status/partial badge), links to `/scans/:id`, and has a "Scan now" launcher (per-persona) that starts a run and navigates to its detail; a dom test proves the list renders from mocked `listScans` and the launcher navigates.

**Files:**
- Create: `src/app/(app)/scans/page.tsx` (`"use client"`)
- Create: `src/caliber-ui/compositions/Scans/ScansList.tsx`
- Test: `src/caliber-ui/compositions/Scans/ScansList.dom.test.tsx`

**Interfaces:**
- Consumes: `listScans`, `startSearch` (`features/search/client`), `SearchRunSummary` (`@/types`), `Card`/`Tag`/`Button`/`ScoreBadge` (`caliber-ui`), `useRouter`.
- Produces: `ScansList({ runs, onOpen }: { runs: SearchRunSummary[]; onOpen(id: string): void })`.

- [ ] **Step 1: Write the failing `ScansList` dom test**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScansList } from "./ScansList";

const run = {
  id: "r1", status: "completed" as const, persona: "remote" as const, resumeName: "jane_v2.pdf",
  startedAt: "2026-07-15T10:00:00.000Z", finishedAt: "2026-07-15T10:01:02.000Z",
  stats: { scanned: 40, matched: 30, scored: 28, worth: 6, ghosts: 2, unscored: 1, capStopped: false, discoverMs: 4200, scoreMs: 58000, costUsd: 0.42, policyVersion: "p3" },
};

it("renders a run row with résumé, duration, and worth count; opens on click", async () => {
  const onOpen = vi.fn();
  render(<ScansList runs={[run]} onOpen={onOpen} />);
  expect(screen.getByText("jane_v2.pdf")).toBeInTheDocument();
  expect(screen.getByText(/6 worth/i)).toBeInTheDocument();
  await userEvent.click(screen.getByText("jane_v2.pdf"));
  expect(onOpen).toHaveBeenCalledWith("r1");
});

it("badges a cap-stopped run as partial", () => {
  render(<ScansList runs={[{ ...run, stats: { ...run.stats, capStopped: true } }]} onOpen={() => {}} />);
  expect(screen.getByText(/partial/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run → FAIL** (component missing).

- [ ] **Step 3: Build `ScansList`** — a `Card`-per-run list. Each row: résumé name (clickable → `onOpen(id)`), a relative-time + duration line (`(finishedAt−startedAt)/1000`s), a verdict-mix line (`{worth} worth · {ghosts} ghost · {scored} scored`), and a status `Tag` (`completed`→`good`; `failed`→`danger`; `stats.capStopped`→a `warn` "partial" tag; `running`→a `caliber-spin` glyph). No new primitive — compose `Card` + flex rows + `Tag`, exactly as `ScanProgress` composes. Keep it presentational; all data via props.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Build the page** `src/app/(app)/scans/page.tsx` (`"use client"`): fetch via `listScans` in a `useEffect` (the established feed/tracker pattern — `useState` for `runs/loading/error`, `useCallback` loader), render `<ScansList runs onOpen={(id) => router.push(`/scans/${id}`)} />`, and a launcher row with a "Scan now" `Button` per persona calling `startSearch({ persona })` then `router.push(`/scans/${run.id}`)`. Handle the `409 ActiveRunConflictError` (`details.activeRunId`) by routing to the existing run's detail instead of erroring (mirror `useScanRun.start`'s conflict handling).

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/scans/page.tsx" src/caliber-ui/compositions/Scans/ScansList.tsx src/caliber-ui/compositions/Scans/ScansList.dom.test.tsx
git commit -m "feat(scans): /scans list page + ScansList + launcher"
```

---

### Task 9: `/scans/:id` phased replay + `ScanReplay` composition

**Model · effort · goal:** `executor` (sonnet) · medium · `/scans/:id` renders a terminal run's persisted `results` as three phased sections — Discover summary, a sortable Score list (by fit / verdict), and a Legitimacy aggregate — plus header stats (résumé, duration, cost, policy); a dom test proves sorting and the aggregate. For a *running* run it shows the existing coarse progress (reused) until M2.

**Files:**
- Create: `src/app/(app)/scans/[id]/page.tsx` (`"use client"`)
- Create: `src/caliber-ui/compositions/Scans/ScanReplay.tsx`
- Test: `src/caliber-ui/compositions/Scans/ScanReplay.dom.test.tsx`

**Interfaces:**
- Consumes: `getScanDetail`, `subscribeSearch` + `useScanRun` (for the running-run coarse view), `ScanDetail`/`ScanResult` (`@/types`), `Card`/`Tag`/`ScoreBadge`/`FitBar`/`Tabs` (`caliber-ui`).
- Produces: `ScanReplay({ detail }: { detail: ScanDetail })`.

- [ ] **Step 1: Write the failing dom test** — assert the header shows the résumé + duration + `$0.42`; the Score list sorts by fit descending by default and re-sorts on a control; the Legitimacy section aggregates tiers (e.g. "2 ghost").

```tsx
it("renders header stats and a fit-sorted score list", () => {
  render(<ScanReplay detail={detailFixture} />);
  expect(screen.getByText("jane_v2.pdf")).toBeInTheDocument();
  expect(screen.getByText(/\$0\.42/)).toBeInTheDocument();
  const rows = screen.getAllByTestId("score-row");
  const fits = rows.map((r) => Number(r.getAttribute("data-fit")));
  expect(fits).toEqual([...fits].sort((a, b) => b - a)); // descending
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Build `ScanReplay`** — three `Card` sections:
  - **Discover:** `stats.scanned` scanned · `stats.matched` matched · `discoverMs` → seconds · per-source found/errors from `stats.perSource`.
  - **Score:** rows from `results.filter(r => r.outcome === "scored")`, each `data-testid="score-row" data-fit={fit}` with `ScoreBadge`, title/company, `verdict` `Tag`, `scoredMs`; a sort control (default fit desc) via `useState`. Show `unscored`/`error`/`skipped` rows in a muted subsection with their reason.
  - **Legitimacy:** aggregate `results` by `legitimacyTier` into counts, rendered as `Tag`s (ghost→`ghost` tone).
  Header: résumé name, persona, start time, total duration (`discoverMs+scoreMs`, or finished−started), `costUsd` as `$x.xx`, `policyVersion`, status/partial badge.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Build the page** `src/app/(app)/scans/[id]/page.tsx` (`"use client"`): read `params.id`, `getScanDetail(id)` in an effect; if `detail.status === "running"` render the existing coarse progress by wiring `useScanRun().subscribeTo(id)` + `<ScanProgress …>` (temporary until M2 — this reuse is explicitly the M1 bridge per spec §4.3); otherwise render `<ScanReplay detail={detail} />`. On 404 show a not-found state.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/scans/[id]/page.tsx" src/caliber-ui/compositions/Scans/ScanReplay.tsx src/caliber-ui/compositions/Scans/ScanReplay.dom.test.tsx
git commit -m "feat(scans): /scans/:id phased replay + ScanReplay"
```

---

### Task 10: Retire the Feed `ScanProgress` overlay + `scanHandoff` (D7)

**Model · effort · goal:** `deep-thinker` (fable) · high · Feed "Scan now" starts a run and navigates to `/scans/:id`; the résumé dual-persona auto-start navigates to `/scans`; `scanHandoff` and the Feed overlay are deleted; feed + resume tests are updated and green, with no dangling imports.

**Files:**
- Modify: `src/app/(app)/feed/page.tsx` (remove overlay + handoff attach; "Scan now" → navigate)
- Modify: `src/app/(app)/resume/page.tsx` (dual-persona start → `router.push("/scans")`)
- Delete: `src/features/search/scanHandoff.ts` + `src/features/search/scanHandoff.test.ts`
- Delete (or keep for M1 bridge): `src/caliber-ui/compositions/Feed/ScanProgress.tsx` — **KEEP** `StageGlyph` (used by `CheckRunRow` and the M1 running-run bridge in Task 9).
- Test: `src/app/(app)/feed/*.test.tsx`, `src/app/(app)/resume/*.test.tsx`

**Interfaces:**
- Consumes: `useRouter`, `startSearch` (`features/search/client`).
- Produces: no new exports; removes `writeScanHandoff`/`takeScanHandoff`/`ScanHandoff` and the Feed overlay usage.

> **`StageGlyph` caveat:** `StageGlyph` lives *inside* `ScanProgress.tsx` (`:24`) and is imported by `CheckRunRow.tsx:5` and reused by Task 9's running bridge. **Do not delete `ScanProgress.tsx` wholesale.** Instead: (a) keep `StageGlyph` + `ScanProgressStageRow` + the `ScanProgress` component itself (Task 9's bridge still renders it for running runs), but (b) remove only the Feed *overlay wiring* and the `scanHandoff` round-trip. If a later cleanup wants `ScanProgress` gone entirely, first extract `StageGlyph` to its own file — out of scope here.

- [ ] **Step 1: Update the failing feed test first** — change the "Scan now" expectation from "opens the overlay" to "calls `startSearch` then `router.push('/scans/<id>')`". Mock `startSearch` to resolve `{ id: "r-new" }` and assert `push`. Run → FAIL against current code.

- [ ] **Step 2: Rewire Feed "Scan now"** (`feed/page.tsx:163-172`): replace `onClick={() => void scan.start(persona)}` with an async handler that `startSearch({ persona })` → `router.push(`/scans/${run.id}`)`, with the same 409-conflict reattach (route to `/scans/${details.activeRunId}`). Remove the `useScanRun` wiring (`:65-71`), the `takeScanHandoff` attach (`:85-93`), and the overlay render block (`:212-235`). Remove now-unused imports (`useScanRun`, `takeScanHandoff`, `ScanProgress`, `ScanHandoff`).

- [ ] **Step 3: Rewire résumé dual-persona start** (`resume/page.tsx:28-47`): after the two `Promise.allSettled` starts succeed, replace `writeScanHandoff(handoff); router.push("/feed")` with `router.push("/scans")`. Remove the `handoff` construction and the `writeScanHandoff`/`ScanHandoff` imports. Both scans are visible in the `/scans` list (that's the retention win).

- [ ] **Step 4: Delete `scanHandoff`** — remove `src/features/search/scanHandoff.ts` and its test. Confirm no other importers: `git grep -n "scanHandoff\|writeScanHandoff\|takeScanHandoff"` → only-now-removed sites.

- [ ] **Step 5: Update the résumé test** — expect `router.push("/scans")` after a successful upload+start. Run the feed + resume suites → PASS.

- [ ] **Step 6: Grep for dangling refs**

Run: `git grep -n "ScanProgress\|useScanRun\|scanHandoff" src/app`
Expected: `useScanRun`/`scanHandoff` gone from `src/app`; `ScanProgress` remains only in the Task-9 `/scans/[id]` running bridge (and `StageGlyph`'s own module). Fix any stragglers.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/feed/page.tsx" "src/app/(app)/resume/page.tsx" src/features/search src/app
git rm src/features/search/scanHandoff.ts src/features/search/scanHandoff.test.ts
git commit -m "refactor(scans): retire Feed ScanProgress overlay + scanHandoff — Scan now → /scans/:id (D7)"
```

---

### Task 11: Full-gate verification + docs regen

**Model · effort · goal:** `executor` (sonnet) · low · `npm run check` is fully green and the contract + component-inventory docs reflect the M1 surface.

- [ ] **Step 1: Regenerate the API contract** — run the contract generator (find it: `git grep -n "api-contract" package.json`; likely `npm run contract:gen` or similar). Commit the regenerated `docs/architecture/api-contract.md` (now including `ScanResult`, `SearchRunSummary`, `ScanDetail`, `GET /api/search`).

- [ ] **Step 2: Update component inventory** — add `ScansList`, `ScanReplay` to `docs/architecture/component-inventory.md` (spec §7).

- [ ] **Step 3: Run the full gate**

Run: `npm run check`
Expected: PASS — typecheck (widened `ScanStats` consumed everywhere; `toSearchRun`/`toScanDetail`/`toSearchRunSummary` supply every field), full vitest, contract check (no drift), build.

- [ ] **Step 4: Commit**

```bash
git add docs/architecture/api-contract.md docs/architecture/component-inventory.md
git commit -m "docs(scans): regenerate api-contract + component-inventory for M1"
```

---

## Deferred out of M1 (tracked, intentional)

- **Live concurrency lanes / enriched SSE events** (`source`, `jobPhase`) → **M2**. During M1 a running `/scans/:id` reuses the existing coarse `ScanProgress` bar.
- **`GET /api/search/:id` SSE stream widening** — M1 leaves the SSE `done`/`progress` vocabulary untouched (the JSON snapshot is what the replay reads). M2 adds the new event names.
- **Cross-run job join table** — rejected in the spec; `jobId` stays inside each `ScanResult` as the promote-later escape hatch.

## Self-Review

- **Spec coverage (§4.1 + §4.3 + §5/§6 edges):** `results` jsonb + widened stats + `resumes.label` → Task 2; `appendResult` (fenced) + `listByUser` (label join) → Task 3; incremental writes + durations + cost → Task 4; cap-hit `skipped:dailyCap` persistence (§5) → Task 4 Step 2b; partial-fail stats (deferred from M0, §5) → Task 4 Step 7; `GET /api/search` list + `ScanDetail` JSON + `getSearchRun` migration → Task 5; contract widening + new schemas → Task 1; `/scans` + `/scans/:id` pages + `ScansList`/`ScanReplay` → Tasks 8–9; nav item → Task 7; D7 retirement → Task 10; docs regen → Task 11.
- **Grounded facts (corrected against code after review):** résumé display name = new `resumes.label` column (the table had none), backfilled + written-on-create (Task 2); numeric fit = `scoreRow.score`, not the jsonb `scoreRow.fit` (Task 4); policy = `policyVersion("match-score")` function, no `POLICY_VERSION` constant (Task 4); nav icon = `activity` (`radar` is taken) (Task 7); error codes from the typed `ErrorCode` enum via `errorResponse`, no `BAD_REQUEST` (Task 5).
- **Correctness fixes verified:** partial-fail catch requires accumulators **hoisted above the `try`** (Task 4 Step 7) — a `catch` can't see try-body `const`s; the JSON-snapshot shape change **breaks `getSearchRun`/`spine.test`** and is migrated in Task 5 Step 4b; the FK to `users` requires inserting `OTHER_USER_ID` before the scoping test (Task 3).
- **Placeholder scan:** none — every code step shows full replacement text or an exact insertion; every run step shows the command + expected result. Remaining pre-write greps confirm only physical snake_case column names in the generated migration and the résumé write-path location — not logic.
- **Type consistency:** `ScanStats` (Task 1) is consumed by `toSearchRun`/`toScanDetail`/`toSearchRunSummary` (Tasks 4–5) and `SearchRun`/`ScanDetail` (Task 1); `ScanResult` shape is written in `run.ts` (Task 4) exactly matching the Zod schema (Task 1) and the DB `$type` (Task 2); `appendResult`/`listByUser`/`getDetail` signatures (Task 3) match their call sites in `run.ts` (Task 4) and the routes (Task 5); `SearchRunSummaryRow` (Task 3) feeds `toSearchRunSummary` (Task 5). `results` column name is identical across schema, repo SQL, and assemblers.
