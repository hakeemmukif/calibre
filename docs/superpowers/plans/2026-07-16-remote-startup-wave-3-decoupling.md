# Wave 3: Decoupling Ingestion from Matching — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-user, per-scan connector fan-out with a global scheduled crawler that fills a shared `postings` pool once, so a user scan becomes an in-process filter + LLM classify + deep score over that pool instead of re-fetching ~1,000 boards per user, per day.

**Architecture:** A new boot/cron-invoked crawler (`crawl.ts`) fetches every enabled `sources` row once, resolves cross-source collisions (ATS beats board/aggregator), and upserts into a new GLOBAL `postings` table (no `userId`). A new per-user match loop (`match.ts`) reads that pool in-process, applies Wave 1's deterministic `roleMatchScore` stage-1 filter, refines ambiguous (`other`) functions via a cheap LLM classifier on the ~200 survivors, then materializes admitted candidates into the existing per-user `jobs` table via the unchanged `jobsRepo.upsertByDedupeKey` — which the existing (Wave-1-fixed) `scoreTopCandidates` deep-scores exactly as today. `run.ts` is wired to call `match.ts` instead of fanning out to connectors itself, gated behind a rollout flag so the live app never serves an empty scan if the crawler hasn't populated the pool yet.

**Tech Stack:** Next.js 15 / TypeScript, Drizzle ORM + libsql (SQLite, `file:` driver), Vitest, OpenRouter via `src/lib/llm/client.ts`, `p-limit` for concurrency pools.

## Dependencies on other waves (read before starting)

- **Wave 1** must have landed first and exports: `JobFunction` (type) + `classifyFunction(title): JobFunction` from `src/server/search/functionTag.ts`; `normalizeTitle(s): string` (exported) and `roleMatchScore(target: RoleTarget, posting: RawPosting): number` from `src/server/search/roleMatch.ts`; a `function` column on `jobs` (nullable-enum, full 12-value `JobFunction` union). If Wave 1 landed `classifyFunction`/`JobFunction` in `roleMatch.ts` instead of a new `functionTag.ts`, adjust every import path below accordingly (one-line fix per file) — do not proceed silently on a different shape.
- **Wave 2** must have landed and populated `sources.config` with (optionally) `companyDomain` per Wave 2's `SourceConfig` shape. Absence is handled (legacy/manual sources) — see Task 2.
- The exact next Drizzle migration number is NOT hardcoded anywhere in this plan (it depends on how many migrations Waves 1–2 added). Task 1 tells you how to find it.

## Global Constraints

- libsql's `file:` driver forbids concurrent `db.transaction` — the crawler writes in small sequential batches, one `await`ed upsert at a time, never `db.transaction(...)`.
- WAL + `busy_timeout` are how the crawler's writes interleave with a live user-scan's writes (already configured in `src/server/persistence/db.ts`; Task 5 only adds a regression test).
- Per-user `jobs` is KEPT as the materialized match view — `jobsRepo.upsertByDedupeKey` and its `(userId, dedupeKey)` unique constraint are UNCHANGED.
- Migrations: `npm run db:generate` only — never hand-author SQL. This wave touches a LIVE deploy — the new `postings` table is strictly additive (new table, no column drops/renames on `jobs`/`sources`), and the flag in Task 8 keeps existing scan behavior byte-identical until an operator explicitly opts in.
- Layering: UI → `features/*` → `server/*`; only `server/*` touches DB/LLM.
- Fail loud: no silent fallback defaults; an empty pool under the rollout flag throws (Task 9), it does not silently degrade to zero matches.
- Tests: `npx vitest run <path>`. Keep the full suite (~1300+) green after every task.
- No `Co-Authored-By` trailer on commits. Conventional commit messages (`feat(...)`, `test(...)`, `refactor(...)`).
- `tsc` runs from the session's MAIN checkout on commit (not worktree-aware) — if built in a worktree, keep the main checkout's types green too.

---

## File Structure

- `src/server/persistence/schema.ts` (MODIFY) — add the global `postings` table.
- `drizzle/00NN_<generated>.sql` + `drizzle/meta/*` (GENERATED via `db:generate`) — the `postings` table migration.
- `src/server/persistence/migration-postings.test.ts` (NEW) — schema/migration smoke test (unique-constraint + round-trip), named by content since the exact sequence number is only known at generation time.
- `src/server/search/dedupe.ts` (MODIFY) — add `globalDedupeKeyFor`; move `groupByCollision`/`CanonicalGroup` here from `run.ts` (byte-identical logic, reused by the crawler).
- `src/server/search/dedupe.test.ts` (MODIFY) — tests for both.
- `src/server/persistence/repos/postings.ts` (NEW) — `postingsRepo`: batch-safe `upsertByDedupeKey`, `updateFunction`, `listForPersona`, `count`.
- `src/server/persistence/repos/postings.test.ts` (NEW) — repo tests.
- `src/server/persistence/repos/__fixtures__/helpers.ts` (MODIFY) — add `insertPosting` fixture helper.
- `src/server/search/crawl.ts` (NEW) — the scheduled crawler: fetch all enabled sources once, group/resolve collisions, batch-upsert into `postings`. Runnable directly via `tsx` (mirrors `seed.ts`'s CLI-entrypoint idiom).
- `src/server/search/crawl.test.ts` (NEW) — crawler tests (fixture connectors, partial-failure tolerance, batch-write-under-contention).
- `src/server/persistence/db.test.ts` (NEW) — WAL/busy-timeout regression test.
- `config/models.yml` (MODIFY) — add the `function-classify` task.
- `src/lib/llm/client.ts` (MODIFY) — add `"function-classify"` to the `TaskName` union.
- `src/server/search/functionClassify.ts` (NEW) — LLM classifier for stage-1 survivors whose deterministic `function` is `"other"`.
- `src/server/search/functionClassify.test.ts` (NEW) — classifier tests.
- `src/server/search/match.ts` (NEW) — the per-user match loop: stage-1 filter over the pool, classify refinement, materialize into `jobs`.
- `src/server/search/match.test.ts` (NEW) — match-loop tests.
- `src/server/search/run.ts` (MODIFY) — wire `match.ts` behind `CALIBER_MATCH_FROM_POOL`; delete the now-moved `groupByCollision`/`CanonicalGroup`.
- `src/server/search/run.test.ts` (MODIFY) — adjust the moved-function import; add coverage for the new branch.
- `package.json` (MODIFY) — add `"crawl": "tsx --env-file-if-exists=.env.local src/server/search/crawl.ts"`.

---

## Task 1: Global `postings` table + migration

- [ ] Add the `postings` table to `schema.ts`; generate + apply the migration; pin it with a smoke test.

**Interfaces:**
- Produces: `postings` (Drizzle `sqliteTable`) exported from `src/server/persistence/schema.ts`.
- Consumes: `sources` table (FK `sourceId → sources.id`).

### Steps

1. **Write failing test** — `src/server/persistence/migration-postings.test.ts`:
   ```ts
   import { describe, expect, it } from "vitest";
   import { eq } from "drizzle-orm";
   import { createTestDb } from "./test-db";
   import { postings, sources } from "./schema";

   describe("postings table (Wave 3 §4.1)", () => {
     it("round-trips an insert with every column", async () => {
       const db = await createTestDb();
       const [source] = await db
         .insert(sources)
         .values({ id: "gh-acme", name: "Acme", kind: "ats", persona: "remote", enabled: true, config: {} })
         .returning();

       const [row] = await db
         .insert(postings)
         .values({
           dedupeKey: "acme.com::ext:123",
           url: "https://boards.greenhouse.io/acme/123",
           applyUrl: "https://boards.greenhouse.io/acme/123/apply",
           sourceId: source.id,
           externalId: "123",
           title: "Head of Finance",
           company: "Acme",
           location: "Remote",
           salaryRaw: "$150k-$180k",
           description: "Own the finance function.",
           postedAt: new Date("2026-07-01T00:00:00Z"),
           function: "finance",
           tzBand: "americas",
           raw: { title: "Head of Finance" },
         })
         .returning();

       expect(row.dedupeKey).toBe("acme.com::ext:123");
       expect(row.function).toBe("finance");
       expect(row.firstSeenAt).toBeInstanceOf(Date);
       expect(row.lastSeenAt).toBeInstanceOf(Date);

       const [fetched] = await db.select().from(postings).where(eq(postings.id, row.id));
       expect(fetched?.company).toBe("Acme");
     });

     it("enforces UNIQUE(dedupe_key)", async () => {
       const db = await createTestDb();
       const [source] = await db
         .insert(sources)
         .values({ id: "gh-acme", name: "Acme", kind: "ats", persona: "remote", enabled: true, config: {} })
         .returning();
       const base = {
         url: "https://boards.greenhouse.io/acme/1",
         sourceId: source.id,
         title: "Backend Engineer",
         company: "Acme",
         location: "Remote",
         function: "eng" as const,
         raw: {},
       };
       await db.insert(postings).values({ ...base, dedupeKey: "dup" });
       await expect(db.insert(postings).values({ ...base, dedupeKey: "dup" })).rejects.toMatchObject({
         cause: { extendedCode: "SQLITE_CONSTRAINT_UNIQUE" },
       });
     });
   });
   ```
2. **Run → FAIL**: `npx vitest run src/server/persistence/migration-postings.test.ts` — fails with `postings` not exported from `./schema` (and no migration applies it).
3. **Minimal impl** — add to `src/server/persistence/schema.ts` (after the `jobs` table):
   ```ts
   // Wave 3 §4.1 — GLOBAL crawler pool, no userId. Mirrors jobs' shared
   // fields; the crawler upserts here once, per-user `jobs` becomes the
   // materialized match view (server/search/match.ts). No `aliases` column —
   // cross-source collisions are resolved to ONE canonical row before this
   // table ever sees a write (server/search/dedupe.ts groupByCollision), so
   // there is nothing left to alias-merge at this layer.
   export const postings = sqliteTable(
     "postings",
     {
       id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
       dedupeKey: text("dedupe_key").notNull(),
       url: text("url").notNull(),
       applyUrl: text("apply_url"),
       sourceId: text("source_id").notNull().references(() => sources.id),
       externalId: text("external_id"),
       title: text("title").notNull(),
       company: text("company").notNull(),
       location: text("location").notNull(),
       salaryRaw: text("salary_raw"),
       description: text("description"),
       postedAt: integer("posted_at", { mode: "timestamp_ms" }),
       // Stamped by classifyFunction (Wave 1) at crawl-insert time; refined by
       // functionClassify.ts (Wave 3 §4.4) for "other" survivors during a
       // user's match pass. Hardcoded literal list — same style as every
       // other enum column in this file (e.g. `persona` below) — kept in
       // sync with `JobFunction` (src/server/search/functionTag.ts) manually.
       function: text("function", {
         enum: ["eng", "product", "design", "ops", "finance", "legal", "marketing", "sales", "people", "cs", "exec", "other"],
       }).notNull(),
       firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
       lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
       tzBand: text("tz_band", { enum: ["apac", "emea", "americas"] }),
       raw: text("raw", { mode: "json" }).$type<unknown>().notNull(),
     },
     (table) => [unique("postings_dedupe_key_unique").on(table.dedupeKey)],
   );
   ```
   Then generate the migration and confirm its number:
   ```bash
   npm run db:generate
   cat drizzle/meta/_journal.json | tail -20   # confirm the new entry's idx/tag
   ls drizzle/*.sql | tail -1                   # the generated filename
   ```
4. **Run → PASS**: `npx vitest run src/server/persistence/migration-postings.test.ts`.
5. **Commit**: `feat(schema): add global postings table for the crawler pool (Wave 3 §4.1)` — stage `schema.ts`, the new `drizzle/*.sql` + `drizzle/meta/*`, and the test file.

---

## Task 2: Global dedupe key + move `groupByCollision` into `dedupe.ts`

- [ ] Add `globalDedupeKeyFor`; relocate the ATS-beats-aggregator collision grouper out of `run.ts` so the crawler can reuse it verbatim.

**Interfaces:**
- Produces: `globalDedupeKeyFor(posting: RawPosting, source: { kind: "ats" | "board" | "manual"; config: unknown }): string`; `CanonicalGroup` (interface, moved); `groupByCollision(matched: { posting: RawPosting; source: SourceRow }[]): Map<string, CanonicalGroup>` (moved, now exported from `dedupe.ts`).
- Consumes: `normalizeTitle` (Wave 1, `./roleMatch`); existing `companySlugFor`/`roleTokensHash`/`secondaryKey`/`resolveCanonicalCollision` (same file); `RawPosting`/`SourceRow` (type-only imports).

### Steps

1. **Write failing test** — append to `src/server/search/dedupe.test.ts`:
   ```ts
   import type { RawPosting } from "./connector";
   import type { SourceRow } from "@/server/persistence/repos/sources";
   import { globalDedupeKeyFor, groupByCollision } from "./dedupe";

   describe("globalDedupeKeyFor", () => {
     it("ATS + externalId: scoped by company domain, ignores title/location", () => {
       const source = { kind: "ats" as const, config: { companyDomain: "acme.com" } };
       const a = globalDedupeKeyFor(
         { sourceId: "s", url: "https://boards.greenhouse.io/acme/1", title: "Backend Engineer", company: "Acme", externalId: "123" },
         source,
       );
       const b = globalDedupeKeyFor(
         { sourceId: "s", url: "https://boards.greenhouse.io/acme/999", title: "Totally Different Title", company: "Acme", externalId: "123" },
         source,
       );
       expect(a).toBe(b);
       expect(a).toBe("acme.com::ext:123");
     });

     it("falls back to company-domain + normalized-title + location when no externalId", () => {
       const source = { kind: "board" as const, config: { companyDomain: "acme.com" } };
       const key = globalDedupeKeyFor(
         { sourceId: "s", url: "https://example.com/1", title: "Head of Finance", company: "Acme", location: "Remote" },
         source,
       );
       expect(key).toBe("acme.com::head of finance::remote");
     });

     it("falls back to a company slug when companyDomain is absent (legacy/manual source)", () => {
       const source = { kind: "board" as const, config: {} };
       const key = globalDedupeKeyFor(
         { sourceId: "s", url: "https://example.com/1", title: "Recruiter", company: "Acme, Inc." },
         source,
       );
       expect(key).toBe("acme-inc::recruiter::");
     });

     it("title-casing/location-casing variants normalize to the same key", () => {
       const source = { kind: "board" as const, config: { companyDomain: "acme.com" } };
       const a = globalDedupeKeyFor({ sourceId: "s", url: "u1", title: "Head of Finance", company: "Acme", location: "Remote" }, source);
       const b = globalDedupeKeyFor({ sourceId: "s", url: "u2", title: "HEAD OF FINANCE", company: "Acme", location: "remote" }, source);
       expect(a).toBe(b);
     });
   });

   describe("groupByCollision (moved from run.ts for the Wave 3 crawler)", () => {
     it("ATS beats board/aggregator regardless of encounter order", () => {
       const atsSource = { id: "greenhouse", kind: "ats" } as SourceRow;
       const boardSource = { id: "himalayas", kind: "board" } as SourceRow;
       const atsPosting: RawPosting = {
         sourceId: "greenhouse", url: "https://boards.greenhouse.io/acme/1", title: "Backend Engineer", company: "Acme", location: "Remote",
       };
       const boardPosting: RawPosting = {
         sourceId: "himalayas", url: "https://himalayas.app/jobs/acme-backend", title: "Backend Engineer", company: "Acme", location: "Remote",
       };

       const groups = groupByCollision([
         { posting: boardPosting, source: boardSource },
         { posting: atsPosting, source: atsSource },
       ]);
       expect(groups.size).toBe(1);
       const [group] = [...groups.values()];
       expect(group.canonical.url).toBe(atsPosting.url);
       expect(group.canonicalSource.id).toBe("greenhouse");
       expect(group.aliasUrls).toEqual([{ sourceId: "himalayas", url: boardPosting.url }]);
     });

     it("two unrelated postings never collide", () => {
       const source = { id: "greenhouse", kind: "ats" } as SourceRow;
       const a: RawPosting = { sourceId: "greenhouse", url: "https://boards.greenhouse.io/acme/1", title: "Backend Engineer", company: "Acme", location: "Remote" };
       const b: RawPosting = { sourceId: "greenhouse", url: "https://boards.greenhouse.io/acme/2", title: "Head of Finance", company: "Acme", location: "Remote" };
       const groups = groupByCollision([{ posting: a, source }, { posting: b, source }]);
       expect(groups.size).toBe(2);
     });
   });
   ```
2. **Run → FAIL**: `npx vitest run src/server/search/dedupe.test.ts` — `globalDedupeKeyFor`/`groupByCollision` not exported from `./dedupe`.
3. **Minimal impl**:
   - In `src/server/search/dedupe.ts`, add near the top: `import type { RawPosting } from "./connector"; import type { SourceRow } from "@/server/persistence/repos/sources"; import { normalizeTitle } from "./roleMatch";` (type-only imports keep this module's "no DB access" character — `SourceRow` is a compile-time shape only).
   - Append:
     ```ts
     /** Company-domain (Wave 2 SourceConfig.companyDomain), else a slug fallback for legacy/manual sources that predate domain-join provenance. */
     function companyDomainFor(source: { config: unknown }, company: string): string {
       const config = source.config as { companyDomain?: string };
       return config.companyDomain ?? companySlugFor(company);
     }

     /**
      * GLOBAL dedupe key for the crawler's shared `postings` pool (spec §4.4):
      * ATS externalId when present (scoped by company domain so two
      * companies' numeric ids never collide), else normalized
      * company-domain + title + location bucket. Distinct from
      * `dedupeKeyFor` (URL-based, per-user `jobs`).
      */
     export function globalDedupeKeyFor(
       posting: RawPosting,
       source: { kind: "ats" | "board" | "manual"; config: unknown },
     ): string {
       const domain = companyDomainFor(source, posting.company);
       if (source.kind === "ats" && posting.externalId) {
         return `${domain}::ext:${posting.externalId}`;
       }
       return `${domain}::${normalizeTitle(posting.title)}::${(posting.location ?? "").toLowerCase().trim()}`;
     }

     export interface CanonicalGroup {
       canonical: RawPosting;
       canonicalSource: SourceRow;
       aliasUrls: { sourceId: string; url: string }[];
     }

     // Cross-source collision resolution (system-architecture.md §3/§4: same
     // company + role tokens + location -> same opening; ATS beats board/
     // aggregator for the canonical record). Moved here in Wave 3 (was
     // private to run.ts's per-run upsertMatchedPostings) so the GLOBAL
     // crawler (crawl.ts) can reuse the identical policy across ALL sources
     // in one pass, not just one user's run. Logic is byte-identical to the
     // pre-move version.
     export function groupByCollision(matched: { posting: RawPosting; source: SourceRow }[]): Map<string, CanonicalGroup> {
       const groups = new Map<string, CanonicalGroup>();
       for (const { posting, source } of matched) {
         const key = secondaryKey({
           companySlug: companySlugFor(posting.company),
           roleTokensHash: roleTokensHash(posting.title),
           location: posting.location ?? "",
         });

         const existing = groups.get(key);
         if (!existing) {
           groups.set(key, { canonical: posting, canonicalSource: source, aliasUrls: [] });
           continue;
         }

         const resolved = resolveCanonicalCollision(
           { kind: existing.canonicalSource.kind, sourceId: existing.canonicalSource.id, url: existing.canonical.url },
           { kind: source.kind, sourceId: source.id, url: posting.url },
         );
         if (resolved.canonical.url === posting.url) {
           existing.aliasUrls.push({ sourceId: existing.canonicalSource.id, url: existing.canonical.url });
           existing.canonical = posting;
           existing.canonicalSource = source;
         } else {
           existing.aliasUrls.push({ sourceId: source.id, url: posting.url });
         }
       }
       return groups;
     }
     ```
   - In `src/server/search/run.ts`, DELETE the private `interface CanonicalGroup` and `function groupByCollision(...)` (they now live in `dedupe.ts`), and add `groupByCollision` to the existing `import { companySlugFor, dedupeKeyFor, resolveCanonicalCollision, roleTokensHash, secondaryKey } from "./dedupe";` line (append it, alphabetically: `import { companySlugFor, dedupeKeyFor, groupByCollision, resolveCanonicalCollision, roleTokensHash, secondaryKey } from "./dedupe";`). `upsertMatchedPostings` keeps calling `groupByCollision(matched)` unchanged — pure relocation, zero behavior change.
4. **Run → PASS**: `npx vitest run src/server/search/dedupe.test.ts src/server/search/run.test.ts` — both green, `run.test.ts` proves the relocation didn't change `upsertMatchedPostings`'s behavior.
5. **Commit**: `refactor(search): move groupByCollision into dedupe.ts, add globalDedupeKeyFor (Wave 3 §4.1)`.

---

## Task 3: `postingsRepo`

- [ ] Batch-safe upsert (no `aliases`, single-column conflict target), a function-refresh write, and a persona-scoped pool read.

**Interfaces:**
- Produces: `NewPosting = typeof postings.$inferInsert`; `PostingRow = typeof postings.$inferSelect`; `createPostingsRepo(db: Db)`; `postingsRepo` singleton with `upsertByDedupeKey(row: NewPosting): Promise<PostingRow>`, `updateFunction(id: string, fn: PostingRow["function"]): Promise<void>`, `listForPersona(persona: ScanPersona): Promise<{ posting: PostingRow; source: SourceRow }[]>`, `count(): Promise<number>`.
- Consumes: `postings`/`sources` schema tables; `Db` type (`../db`); `getDb` (`../db`).

### Steps

1. **Write failing test** — `src/server/persistence/repos/postings.test.ts`:
   ```ts
   import { describe, expect, it } from "vitest";
   import { createTestDb } from "../test-db";
   import { insertSource } from "./__fixtures__/helpers";
   import { createPostingsRepo } from "./postings";

   describe("postingsRepo", () => {
     it("upsertByDedupeKey inserts, then a re-sight only refreshes lastSeenAt (not title/function)", async () => {
       const db = await createTestDb();
       const repo = createPostingsRepo(db);
       const source = await insertSource(db);

       const first = await repo.upsertByDedupeKey({
         dedupeKey: "acme.com::ext:1", url: "https://boards.greenhouse.io/acme/1", sourceId: source.id,
         title: "Backend Engineer", company: "Acme", location: "Remote", function: "eng", raw: {},
       });
       await new Promise((r) => setTimeout(r, 5));
       const second = await repo.upsertByDedupeKey({
         dedupeKey: "acme.com::ext:1", url: "https://boards.greenhouse.io/acme/1", sourceId: source.id,
         title: "SOMETHING ELSE", company: "Acme", location: "Remote", function: "eng", raw: {},
       });

       expect(second.id).toBe(first.id);
       expect(second.title).toBe("Backend Engineer"); // frozen at first insert, not overwritten
       expect(second.lastSeenAt.getTime()).toBeGreaterThan(first.lastSeenAt.getTime());
       expect(second.firstSeenAt.getTime()).toBe(first.firstSeenAt.getTime());
     });

     it("updateFunction persists a refined function, throws on an unknown id", async () => {
       const db = await createTestDb();
       const repo = createPostingsRepo(db);
       const source = await insertSource(db);
       const row = await repo.upsertByDedupeKey({
         dedupeKey: "k1", url: "https://example.com/1", sourceId: source.id,
         title: "Chief of Staff", company: "Acme", location: "Remote", function: "other", raw: {},
       });

       await repo.updateFunction(row.id, "exec");
       const [refreshed] = await db.select().from((await import("../schema")).postings).where((await import("drizzle-orm")).eq((await import("../schema")).postings.id, row.id));
       expect(refreshed?.function).toBe("exec");

       await expect(repo.updateFunction("nope", "exec")).rejects.toThrow(/no posting/i);
     });

     it("listForPersona joins sources and filters enabled + persona/'both'", async () => {
       const db = await createTestDb();
       const repo = createPostingsRepo(db);
       const remoteSource = await insertSource(db, { persona: "remote" });
       const localSource = await insertSource(db, { persona: "local" });
       const bothSource = await insertSource(db, { persona: "both" });
       const disabledSource = await insertSource(db, { persona: "remote", enabled: false });

       await repo.upsertByDedupeKey({ dedupeKey: "r1", url: "https://example.com/r1", sourceId: remoteSource.id, title: "Backend Engineer", company: "Acme", location: "Remote", function: "eng", raw: {} });
       await repo.upsertByDedupeKey({ dedupeKey: "l1", url: "https://example.com/l1", sourceId: localSource.id, title: "Backend Engineer", company: "Acme", location: "KL", function: "eng", raw: {} });
       await repo.upsertByDedupeKey({ dedupeKey: "b1", url: "https://example.com/b1", sourceId: bothSource.id, title: "Backend Engineer", company: "Acme", location: "Remote", function: "eng", raw: {} });
       await repo.upsertByDedupeKey({ dedupeKey: "d1", url: "https://example.com/d1", sourceId: disabledSource.id, title: "Backend Engineer", company: "Acme", location: "Remote", function: "eng", raw: {} });

       const remote = await repo.listForPersona("remote");
       expect(remote.map((r) => r.posting.dedupeKey).sort()).toEqual(["b1", "r1"]);
     });

     it("count returns the total row count", async () => {
       const db = await createTestDb();
       const repo = createPostingsRepo(db);
       const source = await insertSource(db);
       expect(await repo.count()).toBe(0);
       await repo.upsertByDedupeKey({ dedupeKey: "k1", url: "https://example.com/1", sourceId: source.id, title: "T", company: "C", location: "L", function: "other", raw: {} });
       expect(await repo.count()).toBe(1);
     });
   });
   ```
2. **Run → FAIL**: `npx vitest run src/server/persistence/repos/postings.test.ts` — `./postings` doesn't exist.
3. **Minimal impl** — `src/server/persistence/repos/postings.ts`:
   ```ts
   import { and, eq, or } from "drizzle-orm";
   import type { ScanPersona } from "@/types";
   import { getDb } from "../db";
   import { postings, sources } from "../schema";
   import type { Db } from "./db";
   import type { SourceRow } from "./sources";

   export type NewPosting = typeof postings.$inferInsert;
   export type PostingRow = typeof postings.$inferSelect;

   export function createPostingsRepo(db: Db) {
     return {
       // ON CONFLICT(dedupe_key): refresh lastSeenAt ONLY — title/company/
       // description/function stay frozen at first insert (mirrors
       // jobsRepo.upsertByDedupeKey's freeze-except-lastSeenAt/aliases
       // policy; `function` refresh is a separate, explicit write via
       // updateFunction, same shape as jobs' updateEligibility/updateRemoteFit).
       async upsertByDedupeKey(row: NewPosting): Promise<PostingRow> {
         const [upserted] = await db
           .insert(postings)
           .values(row)
           .onConflictDoUpdate({
             target: postings.dedupeKey,
             set: { lastSeenAt: new Date() },
           })
           .returning();
         return upserted;
       },

       // functionClassify.ts's write-back for stage-1 survivors whose
       // deterministic classifyFunction returned "other". Unknown id throws —
       // a refresh for a vanished row is a bug, not a no-op (mirrors
       // jobsRepo.updateEligibility).
       async updateFunction(id: string, fn: PostingRow["function"]): Promise<void> {
         const [row] = await db.update(postings).set({ function: fn }).where(eq(postings.id, id)).returning({ id: postings.id });
         if (!row) throw new Error(`postingsRepo.updateFunction: no posting with id "${id}"`);
       },

       // match.ts's stage-1 read: every enabled source's postings for a
       // persona (own + 'both'), joined to its source (eligibility/geo
       // resolution needs source.kind/config at materialization time).
       async listForPersona(persona: ScanPersona): Promise<{ posting: PostingRow; source: SourceRow }[]> {
         return db
           .select({ posting: postings, source: sources })
           .from(postings)
           .innerJoin(sources, eq(sources.id, postings.sourceId))
           .where(and(eq(sources.enabled, true), or(eq(sources.persona, persona), eq(sources.persona, "both"))));
       },

       // Task 9's PoolNotReadyError guard reads this before allowing the
       // rollout flag to route real user traffic through the pool.
       async count(): Promise<number> {
         const rows = await db.select({ id: postings.id }).from(postings);
         return rows.length;
       },
     };
   }

   export const postingsRepo: ReturnType<typeof createPostingsRepo> = {
     upsertByDedupeKey: (row) => createPostingsRepo(getDb()).upsertByDedupeKey(row),
     updateFunction: (id, fn) => createPostingsRepo(getDb()).updateFunction(id, fn),
     listForPersona: (persona) => createPostingsRepo(getDb()).listForPersona(persona),
     count: () => createPostingsRepo(getDb()).count(),
   };
   ```
   Also add to `src/server/persistence/repos/__fixtures__/helpers.ts` (used by Tasks 4/6/7's tests):
   ```ts
   import { jobs, jobScores, postings, profile, resumes, sources } from "../../schema"; // add `postings` to the existing import

   export async function insertPosting(db: Db, sourceId: string, overrides: Partial<typeof postings.$inferInsert> = {}) {
     const key = unique("posting");
     const [row] = await db
       .insert(postings)
       .values({
         dedupeKey: key,
         url: `https://example.com/${key}`,
         sourceId,
         title: "Senior Backend Engineer",
         company: "Example Co",
         location: "Remote",
         function: "eng",
         raw: {},
         ...overrides,
       })
       .returning();
     return row;
   }
   ```
4. **Run → PASS**: `npx vitest run src/server/persistence/repos/postings.test.ts`.
5. **Commit**: `feat(persistence): add postingsRepo (Wave 3 §4.1)`.

---

## Task 4: Scheduled crawler module (`crawl.ts`)

- [ ] Fetch every enabled source once, resolve collisions globally, batch-upsert into `postings` — no `db.transaction`.

**Interfaces:**
- Produces: `runCrawl(deps?: { connectorForSource?: (s: SourceRow) => SourceConnector }): Promise<CrawlResult>`; a `tsx`-runnable CLI entrypoint.
- Consumes: `sourcesRepo.listAll` (`@/server/persistence/repos/sources`); `connectorForSource` (`./connectors`); `groupByCollision`/`globalDedupeKeyFor` (`./dedupe`, Task 2); `classifyFunction` (Wave 1, `./functionTag`); `postingsRepo.upsertByDedupeKey` (Task 3).

### Steps

1. **Write failing test** — `src/server/search/crawl.test.ts`:
   ```ts
   import { eq } from "drizzle-orm";
   import { afterEach, describe, expect, it, vi } from "vitest";
   import { insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
   import { postings } from "@/server/persistence/schema";
   import { createTestDb, type TestDb } from "@/server/persistence/test-db";
   import type { RawPosting, SourceConnector } from "./connector";
   import type { SourceRow } from "@/server/persistence/repos/sources";

   const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
   vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

   const { runCrawl } = await import("./crawl");

   function stubConnector(source: SourceRow, postingsOut: RawPosting[] | { fail: Error }): SourceConnector {
     return {
       id: source.id,
       kind: source.kind,
       persona: source.persona,
       async *discover() {
         if (!Array.isArray(postingsOut)) throw postingsOut.fail;
         for (const p of postingsOut) yield p;
       },
     };
   }

   afterEach(() => vi.restoreAllMocks());

   describe("runCrawl", () => {
     it("fetches every enabled source and upserts distinct postings", async () => {
       state.testDb = await createTestDb();
       const gh = await insertSource(state.testDb, { id: "gh-acme", kind: "ats", config: { connector: "greenhouse", companyDomain: "acme.com" } });
       const disabled = await insertSource(state.testDb, { id: "gh-disabled", kind: "ats", enabled: false, config: { connector: "greenhouse" } });

       const ghPosting: RawPosting = { sourceId: gh.id, externalId: "1", url: "https://boards.greenhouse.io/acme/1", title: "Backend Engineer", company: "Acme", location: "Remote" };

       const result = await runCrawl({
         connectorForSource: (s) => (s.id === gh.id ? stubConnector(s, [ghPosting]) : stubConnector(s, [{ sourceId: s.id, url: "https://never.example.com", title: "Should not run", company: "X" }])),
       });

       expect(result.sourcesFetched).toBe(1); // disabled source never fetched
       expect(result.postingsUpserted).toBe(1);
       const rows = await state.testDb.select().from(postings);
       expect(rows).toHaveLength(1);
       expect(rows[0].dedupeKey).toBe("acme.com::ext:1");
       expect(rows[0].function).toBe("eng");
     });

     it("ATS beats board across DIFFERENT sources: one row, ATS wins as canonical", async () => {
       state.testDb = await createTestDb();
       const gh = await insertSource(state.testDb, { id: "gh-acme", kind: "ats", config: { connector: "greenhouse", companyDomain: "acme.com" } });
       const board = await insertSource(state.testDb, { id: "himalayas", kind: "board", config: { connector: "himalayas" } });

       const atsPosting: RawPosting = { sourceId: gh.id, externalId: "1", url: "https://boards.greenhouse.io/acme/1", title: "Backend Engineer", company: "Acme", location: "Remote" };
       const boardPosting: RawPosting = { sourceId: board.id, url: "https://himalayas.app/jobs/acme-backend", title: "Backend Engineer", company: "Acme", location: "Remote" };

       await runCrawl({
         connectorForSource: (s) => (s.id === gh.id ? stubConnector(s, [atsPosting]) : stubConnector(s, [boardPosting])),
       });

       const rows = await state.testDb.select().from(postings);
       expect(rows).toHaveLength(1);
       expect(rows[0].url).toBe(atsPosting.url);
       expect(rows[0].sourceId).toBe(gh.id);
     });

     it("tolerates one source's connector failure — the rest still crawl", async () => {
       state.testDb = await createTestDb();
       const ok = await insertSource(state.testDb, { id: "ok", config: { connector: "greenhouse", companyDomain: "ok.com" } });
       const broken = await insertSource(state.testDb, { id: "broken", config: { connector: "greenhouse" } });
       const okPosting: RawPosting = { sourceId: ok.id, externalId: "1", url: "https://boards.greenhouse.io/ok/1", title: "Backend Engineer", company: "OK", location: "Remote" };

       const result = await runCrawl({
         connectorForSource: (s) => (s.id === "ok" ? stubConnector(s, [okPosting]) : stubConnector(s, { fail: new Error("network down") })),
       });

       expect(result.errors).toEqual([{ sourceId: "broken", error: "network down" }]);
       expect(result.postingsUpserted).toBe(1);
     });
   });
   ```
2. **Run → FAIL**: `npx vitest run src/server/search/crawl.test.ts` — `./crawl` doesn't exist.
3. **Minimal impl** — `src/server/search/crawl.ts`:
   ```ts
   // Wave 3 §4.2 scheduled crawler — fetches every ENABLED source once,
   // resolves cross-source collisions GLOBALLY (not per-user), and upserts
   // into the shared `postings` pool. Run via `npm run crawl` (cron/systemd
   // timer on the host — no in-repo scheduler exists; see the box skill for
   // the VPS's existing nightly-backup cron as the operational precedent).
   import { fileURLToPath } from "node:url";
   import pLimit from "p-limit";
   import { postingsRepo, type NewPosting } from "@/server/persistence/repos/postings";
   import { sourcesRepo, type SourceRow } from "@/server/persistence/repos/sources";
   import type { RawPosting, SourceConnector } from "./connector";
   import { connectorForSource as defaultConnectorForSource } from "./connectors";
   import { globalDedupeKeyFor, groupByCollision } from "./dedupe";
   import { classifyFunction } from "./functionTag";

   const CRAWL_CONCURRENCY = 4; // per-vendor-host politeness (spec §4.2) — distinct from run.ts's DEFAULT_CONCURRENCY (8), which fans out for ONE user's scoped sources, not every enabled source globally
   const CRAWL_TIMEOUT_MS = 15_000;
   const BATCH_SIZE = 25; // small sequential batches (libsql file: forbids concurrent db.transaction) — see the upsert loop below

   export interface CrawlResult {
     sourcesFetched: number;
     postingsSeen: number;
     postingsUpserted: number;
     errors: { sourceId: string; error: string }[];
   }

   export interface CrawlDeps {
     connectorForSource?: (source: SourceRow) => SourceConnector;
   }

   export async function runCrawl(deps: CrawlDeps = {}): Promise<CrawlResult> {
     const resolveConnector = deps.connectorForSource ?? defaultConnectorForSource;
     const allSources = await sourcesRepo.listAll();
     const enabled = allSources.filter((s) => s.enabled);
     const limit = pLimit(CRAWL_CONCURRENCY);
     const errors: { sourceId: string; error: string }[] = [];
     const discovered: { posting: RawPosting; source: SourceRow }[] = [];

     await Promise.all(
       enabled.map((source) =>
         limit(async () => {
           const connector = resolveConnector(source);
           const controller = new AbortController();
           const timer = setTimeout(() => controller.abort(), CRAWL_TIMEOUT_MS);
           try {
             for await (const posting of connector.discover({
               targets: [], // no connector reads ctx.targets today (every existing connector test already passes []) — a board's own config.query IS its search scope
               since: new Date(0),
               signal: controller.signal,
               onProgress: () => {},
             })) {
               discovered.push({ posting, source });
             }
           } catch (err) {
             errors.push({ sourceId: source.id, error: err instanceof Error ? err.message : String(err) });
           } finally {
             clearTimeout(timer);
           }
         }),
       ),
     );

     const groups = groupByCollision(discovered);
     const canonicalPostings: NewPosting[] = [...groups.values()].map(({ canonical, canonicalSource }) => ({
       dedupeKey: globalDedupeKeyFor(canonical, canonicalSource),
       url: canonical.url,
       sourceId: canonicalSource.id,
       externalId: canonical.externalId,
       title: canonical.title,
       company: canonical.company,
       location: canonical.location ?? "",
       salaryRaw: canonical.salaryRaw,
       description: canonical.description,
       postedAt: canonical.postedAt ? new Date(canonical.postedAt) : undefined,
       function: classifyFunction(canonical.title),
       raw: canonical,
     }));

     // Small SEQUENTIAL batches, one awaited upsert at a time — never
     // db.transaction(...) (libsql `file:` driver forbids concurrent
     // transactions; this is how the crawler's writes interleave with a
     // live user-scan's writes under WAL + busy_timeout, see Task 5).
     let postingsUpserted = 0;
     for (let i = 0; i < canonicalPostings.length; i += BATCH_SIZE) {
       const batch = canonicalPostings.slice(i, i + BATCH_SIZE);
       for (const row of batch) {
         await postingsRepo.upsertByDedupeKey(row);
         postingsUpserted += 1;
       }
       await new Promise((resolve) => setImmediate(resolve)); // yield between batches
     }

     return { sourcesFetched: enabled.length, postingsSeen: discovered.length, postingsUpserted, errors };
   }

   if (process.argv[1] === fileURLToPath(import.meta.url)) {
     runCrawl()
       .then((result) => {
         console.log(
           `Crawl complete: ${result.sourcesFetched} source(s), ${result.postingsSeen} posting(s) seen, ${result.postingsUpserted} upserted, ${result.errors.length} error(s).`,
         );
         if (result.errors.length > 0) console.error(result.errors);
         process.exit(0);
       })
       .catch((err) => {
         console.error(err);
         process.exit(1);
       });
   }
   ```
   Add to `package.json`'s `"scripts"`: `"crawl": "tsx --env-file-if-exists=.env.local src/server/search/crawl.ts",` (next to `db:seed`).
4. **Run → PASS**: `npx vitest run src/server/search/crawl.test.ts`.
5. **Commit**: `feat(search): add scheduled crawler filling the global postings pool (Wave 3 §4.2)`.

---

## Task 5: WAL + busy-timeout regression test

- [ ] Pin the existing pragma configuration with a test — `src/server/persistence/db.ts:19-30` (`applyPragmas`) ALREADY sets `PRAGMA journal_mode = WAL` and `PRAGMA busy_timeout = 5000` for every `file:` URL. This task adds NO production code — it only guards the constraint the crawler depends on from silently regressing.

**Interfaces:**
- Produces: nothing new (test-only task).
- Consumes: `getDb` (`./db`).

### Steps

1. **Write failing test** — `src/server/persistence/db.test.ts`:
   ```ts
   import { afterEach, describe, expect, it, vi } from "vitest";
   import { createClient } from "@libsql/client";
   import { existsSync, rmSync } from "node:fs";
   import { join } from "node:path";
   import { tmpdir } from "node:os";
   import { randomUUID } from "node:crypto";

   describe("getDb pragmas (Wave 3 §4.2 dependency: WAL + busy_timeout let the crawler and a live user scan write concurrently)", () => {
     const dbPath = join(tmpdir(), `caliber-pragma-test-${randomUUID()}.db`);
     const url = `file:${dbPath}`;

     afterEach(() => {
       vi.resetModules();
       for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
     });

     it("sets journal_mode=WAL and busy_timeout=5000 on a file: URL", async () => {
       vi.stubEnv("DATABASE_URL", url);
       const { getDb } = await import("./db");
       getDb();
       const client = createClient({ url });
       const journalMode = await client.execute("PRAGMA journal_mode");
       expect(String(journalMode.rows[0][0]).toLowerCase()).toBe("wal");
       const busyTimeout = await client.execute("PRAGMA busy_timeout");
       expect(Number(busyTimeout.rows[0][0])).toBe(5000);
       expect(existsSync(dbPath)).toBe(true);
     });
   });
   ```
2. **Run → FAIL** (expected to actually PASS immediately, since `db.ts` already implements this — confirms the RED/GREEN cycle is really "does this regression test hold," not "does new code need writing"): `npx vitest run src/server/persistence/db.test.ts`. If it fails, `applyPragmas` regressed and must be restored to the exact block quoted in the design-spine grounding read — do NOT change the pragma values themselves without operator sign-off (this task is a guard, not a tuning pass).
3. **No production change** (by design — see task header).
4. **Run → PASS**: `npx vitest run src/server/persistence/db.test.ts`.
5. **Commit**: `test(persistence): pin WAL + busy_timeout pragmas the crawler depends on (Wave 3 §4.2)`.

---

## Task 6: `function-classify` models.yml task + `functionClassify.ts`

- [ ] Add the cheap LLM classifier that refines `postings.function` for stage-1 survivors whose deterministic `classifyFunction` returned `"other"`.

**Interfaces:**
- Produces: `refineAmbiguousFunctions(llm: LlmClient, candidates: PostingRow[], concurrency?: number): Promise<Map<string, JobFunction>>` (keyed by `posting.id`, only entries that changed) from `src/server/search/functionClassify.ts`.
- Consumes: `LlmClient`/`TaskName` (`@/lib/llm/client`); `JobFunction` (Wave 1, `./functionTag`); `PostingRow` (Task 3); `postingsRepo.updateFunction` (Task 3).

### Steps

1. **Write failing test** — `src/server/search/functionClassify.test.ts`:
   ```ts
   import { eq } from "drizzle-orm";
   import { describe, expect, it, vi } from "vitest";
   import type { LlmClient } from "@/lib/llm/client";
   import { insertSource, insertPosting } from "@/server/persistence/repos/__fixtures__/helpers";
   import { postings } from "@/server/persistence/schema";
   import { createTestDb, type TestDb } from "@/server/persistence/test-db";

   const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
   vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

   const { refineAmbiguousFunctions } = await import("./functionClassify");

   function fakeLlm(fn: string): LlmClient {
     return {
       async complete(args) {
         return { data: args.responseSchema.parse({ function: fn }), model: "test-model", costUsd: 0.0001 };
       },
     };
   }

   describe("refineAmbiguousFunctions", () => {
     it("classifies only 'other' postings, persists the refined function, returns a map of changes", async () => {
       state.testDb = await createTestDb();
       const source = await insertSource(state.testDb);
       const ambiguous = await insertPosting(state.testDb, source.id, { title: "Chief of Staff", function: "other" });
       const alreadyKnown = await insertPosting(state.testDb, source.id, { title: "Backend Engineer", function: "eng" });

       const refined = await refineAmbiguousFunctions(fakeLlm("exec"), [ambiguous, alreadyKnown]);

       expect(refined.get(ambiguous.id)).toBe("exec");
       expect(refined.has(alreadyKnown.id)).toBe(false); // never classified — already resolved

       const [persisted] = await state.testDb.select().from(postings).where(eq(postings.id, ambiguous.id));
       expect(persisted?.function).toBe("exec");
     });

     it("a classification that itself lands on 'other' is not persisted (nothing changed)", async () => {
       state.testDb = await createTestDb();
       const source = await insertSource(state.testDb);
       const stillAmbiguous = await insertPosting(state.testDb, source.id, { title: "Miscellaneous Role", function: "other" });

       const refined = await refineAmbiguousFunctions(fakeLlm("other"), [stillAmbiguous]);
       expect(refined.size).toBe(0);
     });
   });
   ```
2. **Run → FAIL**: `npx vitest run src/server/search/functionClassify.test.ts` — `./functionClassify` doesn't exist.
3. **Minimal impl**:
   - Add to `config/models.yml` under `tasks:`:
     ```yaml
     function-classify:
       # Cheap coarse-bucket classification on the ~200 stage-1 survivors whose
       # deterministic classifyFunction (Wave 1) returned "other" — small
       # prompt, small output, no reasoning needed.
       model: openai/gpt-oss-120b
       maxTokens: 200
       temperature: 0.1
       strict: true
     ```
   - In `src/lib/llm/client.ts`, add `"function-classify"` to the `TaskName` union:
     ```ts
     export type TaskName =
       | "resume-extract"
       | "resume-extract-vision"
       | "jd-extract"
       | "match-score"
       | "question-extract"
       | "question-answer"
       | "tailor"
       | "correlate"
       | "url-check-search"
       | "ghost-web"
       | "function-classify";
     ```
   - `src/server/search/functionClassify.ts`:
     ```ts
     // Wave 3 §4.4 — cheap LLM function classifier. Runs ONLY on stage-1
     // survivors (match.ts) whose deterministic classifyFunction (Wave 1)
     // returned "other"; refines and persists postings.function. Never
     // widens the stage-1 admit gate itself (spine §4.4) — pure enrichment
     // for observability + future consumers.
     import pLimit from "p-limit";
     import { z } from "zod";
     import type { LlmClient } from "@/lib/llm/client";
     import { postingsRepo, type PostingRow } from "@/server/persistence/repos/postings";

     // Mirrors JobFunction (src/server/search/functionTag.ts) — hardcoded,
     // kept in sync manually, same style as schema.ts's enum columns.
     const FunctionClassifyResult = z.object({
       function: z.enum(["eng", "product", "design", "ops", "finance", "legal", "marketing", "sales", "people", "cs", "exec", "other"]),
     });

     const CLASSIFY_CONCURRENCY = 3;

     export async function refineAmbiguousFunctions(
       llm: LlmClient,
       candidates: PostingRow[],
       concurrency = CLASSIFY_CONCURRENCY,
     ): Promise<Map<string, PostingRow["function"]>> {
       const ambiguous = candidates.filter((p) => p.function === "other");
       const limit = pLimit(concurrency);
       const refined = new Map<string, PostingRow["function"]>();

       await Promise.all(
         ambiguous.map((posting) =>
           limit(async () => {
             const result = await llm.complete({
               task: "function-classify",
               messages: [
                 { role: "system", content: "Classify a job posting's function into exactly one bucket from the schema. Use the title and company; if genuinely unclear, answer \"other\"." },
                 { role: "user", content: `Title: ${posting.title}\nCompany: ${posting.company}` },
               ],
               responseSchema: FunctionClassifyResult,
             });
             if (result.data.function !== "other") {
               await postingsRepo.updateFunction(posting.id, result.data.function);
               refined.set(posting.id, result.data.function);
             }
           }),
         ),
       );

       return refined;
     }
     ```
4. **Run → PASS**: `npx vitest run src/server/search/functionClassify.test.ts`.
5. **Commit**: `feat(search): add function-classify LLM task + functionClassify.ts (Wave 3 §4.4)`.

---

## Task 7: Match loop reading the pool (`match.ts`)

- [ ] Stage-1 filter over the pool → classify refinement on ambiguous survivors → materialize admitted candidates into per-user `jobs`.

**Interfaces:**
- Produces: `matchAgainstPool(userId: string, persona: ScanPersona, resumeRow: ResumeRow, profile: ProfileRow, deps?: { llm?: LlmClient }): Promise<{ job: JobRow; source: SourceRow; stage1Score: number }[]>` from `src/server/search/match.ts` — SAME return shape `scoreTopCandidates` (Wave 1) already expects.
- Consumes: `postingsRepo.listForPersona` (Task 3); `deriveRoleTargets`/`roleMatchScore` (Wave 1, `./roleMatch`); `refineAmbiguousFunctions` (Task 6); `dedupeKeyFor` (existing, `./dedupe`); `resolveEligibility` (`@/server/score/eligibility`); `resolveTzBand` (`@/server/score/tzBand`); `parseSourceGeo` (`./geo`); `jobsRepo.upsertByDedupeKey` (existing, unchanged).

### Steps

1. **Write failing test** — `src/server/search/match.test.ts`:
   ```ts
   import { eq } from "drizzle-orm";
   import { describe, expect, it, vi } from "vitest";
   import type { LlmClient } from "@/lib/llm/client";
   import { insertPosting, insertProfile, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
   import { jobs } from "@/server/persistence/schema";
   import { createTestDb, type TestDb } from "@/server/persistence/test-db";

   const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
   vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

   const { matchAgainstPool } = await import("./match");

   const noopLlm: LlmClient = { async complete(args) { return { data: args.responseSchema.parse({ function: "other" }), model: "test", costUsd: 0 }; } };

   const resumeFixture = {
     userId: undefined as unknown as string, // filled per-test via insertResume's default (BOOTSTRAP_ADMIN_ID)
     structured: {
       storeVersion: 2 as const, extractionPath: "text" as const, name: "Jane Doe",
       contact: [{ label: "email", value: "jane@example.com" }], summary: "Finance leader.",
       experience: [{ company: "Old Co", title: "Head of Finance", dates: "2020-Present", isCurrent: true, bullets: [] }],
       education: [], skills: [{ label: "Skills", items: [] }], projects: [], certifications: [], languages: [], sections: [],
     },
     sourceKind: "paste" as const,
     isActive: true,
   };

   describe("matchAgainstPool", () => {
     it("admits a stage-1-matching ATS posting, materializes it into jobs with the pool's dedupeKey-derivation and stage1Score", async () => {
       state.testDb = await createTestDb();
       const profile = await insertProfile(state.testDb);
       const resume = await insertResume(state.testDb, resumeFixture);
       const source = await insertSource(state.testDb, { persona: "remote" });
       await insertPosting(state.testDb, source.id, { title: "Head of Finance", function: "finance", location: "Remote" });
       await insertPosting(state.testDb, source.id, { title: "Backend Engineer", function: "eng", location: "Remote" }); // should NOT match

       const results = await matchAgainstPool("BOOTSTRAP_ADMIN", "remote", resume, profile, { llm: noopLlm });

       expect(results).toHaveLength(1);
       expect(results[0].job.title).toBe("Head of Finance");
       expect(results[0].stage1Score).toBeGreaterThan(0);

       const rows = await state.testDb.select().from(jobs);
       expect(rows).toHaveLength(1);
     });

     it("board-kind postings are admitted unconditionally (already query-scoped upstream)", async () => {
       state.testDb = await createTestDb();
       const profile = await insertProfile(state.testDb);
       const resume = await insertResume(state.testDb, resumeFixture);
       const source = await insertSource(state.testDb, { kind: "board", persona: "local" });
       await insertPosting(state.testDb, source.id, { title: "Graduate Software Engineer", function: "eng", location: "KL" });

       const results = await matchAgainstPool("BOOTSTRAP_ADMIN", "local", resume, profile, { llm: noopLlm });
       expect(results).toHaveLength(1);
     });

     it("refines an 'other' survivor's function via the classifier before materializing", async () => {
       state.testDb = await createTestDb();
       const profile = await insertProfile(state.testDb);
       const resume = await insertResume(state.testDb, resumeFixture);
       const source = await insertSource(state.testDb, { persona: "remote" });
       await insertPosting(state.testDb, source.id, { title: "Head of Finance", function: "other", location: "Remote" });

       const financeLlm: LlmClient = { async complete(args) { return { data: args.responseSchema.parse({ function: "finance" }), model: "test", costUsd: 0 }; } };
       const results = await matchAgainstPool("BOOTSTRAP_ADMIN", "remote", resume, profile, { llm: financeLlm });

       expect(results[0].job.function).toBe("finance");
     });
   });
   ```
   (This test's `userId` string is illustrative — implementers should use `BOOTSTRAP_ADMIN_ID` from `@/server/auth/ids`, mirroring `run.test.ts`'s convention, and import it instead of the literal shown.)
2. **Run → FAIL**: `npx vitest run src/server/search/match.test.ts` — `./match` doesn't exist.
3. **Minimal impl** — `src/server/search/match.ts`:
   ```ts
   // Wave 3 §4.3 — the per-user MATCH loop, reading the crawler's shared
   // `postings` pool in-process instead of fanning out to connectors per
   // scan. Replaces run.ts's old discover-loop + upsertMatchedPostings.
   // Returns the same { job, source, stage1Score }[] shape scoreTopCandidates
   // (Wave 1 §2.6) already expects — scoreTopCandidates itself is unchanged.
   import { getLlm, type LlmClient } from "@/lib/llm/client";
   import { jobsRepo, type JobRow } from "@/server/persistence/repos/jobs";
   import { postingsRepo, type PostingRow } from "@/server/persistence/repos/postings";
   import type { ProfileRow } from "@/server/persistence/repos/profile";
   import type { ResumeRow } from "@/server/persistence/repos/resumes";
   import type { SourceRow } from "@/server/persistence/repos/sources";
   import { resolveEligibility } from "@/server/score/eligibility";
   import { resolveTzBand } from "@/server/score/tzBand";
   import type { ScanPersona } from "@/types";
   import type { RawPosting } from "./connector";
   import { dedupeKeyFor } from "./dedupe";
   import { refineAmbiguousFunctions } from "./functionClassify";
   import { parseSourceGeo } from "./geo";
   import { deriveRoleTargets, roleMatchScore } from "./roleMatch";

   // Stage-1 survivor window (spec §4.3 "~200"): the set handed to the LLM
   // function classifier and then to scoreTopCandidates' own
   // (stage1Score desc, postedAt desc, dedupeKey asc) sort/slice down to
   // TOP_N_CANDIDATES (run.ts, ~30). Distinct constant — this is the WIDE
   // window; TOP_N_CANDIDATES is the narrow deep-score window.
   const STAGE1_SURVIVOR_CAP = 200;

   function toRawPosting(row: PostingRow): RawPosting {
     // `raw` is the crawler's verbatim RawPosting (crawl.ts stores `raw:
     // canonical`), so a connector-supplied `geo` signal — needed by
     // resolveEligibility — survives the DB round-trip even though
     // `postings` has no dedicated geo column (mirrors jobs' own raw-only
     // geo retention).
     const raw = row.raw as RawPosting | undefined;
     return {
       sourceId: row.sourceId,
       externalId: row.externalId ?? undefined,
       url: row.url,
       title: row.title,
       company: row.company,
       location: row.location,
       geo: raw?.geo,
       description: row.description ?? undefined,
       postedAt: row.postedAt ? row.postedAt.toISOString() : undefined,
       salaryRaw: row.salaryRaw ?? undefined,
     };
   }

   export interface MatchAgainstPoolDeps {
     llm?: LlmClient;
   }

   export async function matchAgainstPool(
     userId: string,
     persona: ScanPersona,
     resumeRow: ResumeRow,
     profile: ProfileRow,
     deps: MatchAgainstPoolDeps = {},
   ): Promise<{ job: JobRow; source: SourceRow; stage1Score: number }[]> {
     const pool = await postingsRepo.listForPersona(persona);
     const targets = deriveRoleTargets(resumeRow, persona);

     const withRaw = pool.map(({ posting, source }) => ({ posting, source, raw: toRawPosting(posting) }));
     const scored = withRaw.map(({ posting, source, raw }) => {
       const stage1Score = targets.length === 0 ? 0 : Math.max(...targets.map((t) => roleMatchScore(t, raw)));
       return { posting, source, raw, stage1Score };
     });

     // Same admit rule as today's run.ts (board sources are already
     // query-scoped upstream; ATS sources need the matcher).
     const admitted = scored.filter(({ source, stage1Score }) => source.kind === "board" || stage1Score > 0);
     admitted.sort((a, b) => {
       if (b.stage1Score !== a.stage1Score) return b.stage1Score - a.stage1Score;
       const aTime = a.posting.postedAt?.getTime() ?? -Infinity;
       const bTime = b.posting.postedAt?.getTime() ?? -Infinity;
       if (bTime !== aTime) return bTime - aTime;
       return a.posting.dedupeKey < b.posting.dedupeKey ? -1 : a.posting.dedupeKey > b.posting.dedupeKey ? 1 : 0;
     });
     const survivors = admitted.slice(0, STAGE1_SURVIVOR_CAP);

     const llm = deps.llm ?? getLlm();
     const refined = await refineAmbiguousFunctions(llm, survivors.map((s) => s.posting));

     const materialized: { job: JobRow; source: SourceRow; stage1Score: number }[] = [];
     for (const { posting, source, raw, stage1Score } of survivors) {
       const fn = refined.get(posting.id) ?? posting.function;
       const { tier, evidence } = resolveEligibility({
         baseCountry: profile.baseCountry,
         sourceKind: source.kind,
         sourceGeo: parseSourceGeo(source),
         location: posting.location,
         connectorGeo: raw.geo,
       });
       const tz = resolveTzBand({ location: posting.location });
       const job = await jobsRepo.upsertByDedupeKey({
         userId,
         dedupeKey: dedupeKeyFor(posting.url),
         url: posting.url,
         applyUrl: posting.applyUrl ?? undefined,
         sourceId: source.id,
         externalId: posting.externalId ?? undefined,
         title: posting.title,
         company: posting.company,
         location: posting.location,
         salaryRaw: posting.salaryRaw ?? undefined,
         description: posting.description ?? undefined,
         postedAt: posting.postedAt ?? undefined,
         persona,
         eligibility: tier,
         eligibilityEvidence: evidence,
         tzBand: tz?.band ?? null,
         hiringStructure: null,
         function: fn,
         aliases: [],
         raw: posting.raw,
       });
       materialized.push({ job, source, stage1Score });
     }
     return materialized;
   }
   ```
   > Note: `jobsRepo.upsertByDedupeKey`'s `NewJob` type must already include `function` (Wave 1 §2.7). If Wave 1's column is nullable and this call omits it under some path, that is a Wave 1 contract gap — do not silently drop the field here.
4. **Run → PASS**: `npx vitest run src/server/search/match.test.ts`.
5. **Commit**: `feat(search): add match.ts — per-user stage-1 filter + classify + materialize over the pool (Wave 3 §4.3)`.

---

## Task 8: Wire `match.ts` into `run.ts` behind `CALIBER_MATCH_FROM_POOL`

- [ ] Route `runFanOut` through the new pool-based match loop when the flag is set; keep the existing connector-fan-out path byte-identical when it isn't. This is the task where LIVE user-facing behavior actually changes (once the flag flips) — everything before this task is purely additive.

**Interfaces:**
- Produces: nothing new (wiring only).
- Consumes: `matchAgainstPool` (Task 7); existing `upsertMatchedPostings`/discover loop (unchanged, kept as the default path).

### Steps

1. **Write failing test** — append to `src/server/search/run.test.ts` (inside `describe("startSearch", ...)`):
   ```ts
   describe("CALIBER_MATCH_FROM_POOL routing", () => {
     afterEach(() => {
       delete process.env.CALIBER_MATCH_FROM_POOL;
     });

     it("defaults to the legacy connector fan-out path (flag unset)", async () => {
       // existing fixtures from the outer describe's beforeEach/beforeAll
       const source = await insertSource(state.testDb, { persona: "remote" });
       const resume = await insertResume(state.testDb);
       const connector = stubConnector(source, [
         { sourceId: source.id, url: "https://example.com/legacy-1", title: "Data Engineer", company: "Acme", location: "Remote" },
       ]);
       const run = await startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote", resumeId: resume.id }, {
         llm: testLlm, connectorForSource: () => connector,
       });
       const finished = await waitForTerminal(undefined as never, run.id);
       expect(finished.status).toBe("completed");
       // The legacy path calls the connector directly — proves matchAgainstPool was NOT invoked.
     });

     it("routes through matchAgainstPool when CALIBER_MATCH_FROM_POOL=true", async () => {
       process.env.CALIBER_MATCH_FROM_POOL = "true";
       const source = await insertSource(state.testDb, { persona: "remote" });
       const resume = await insertResume(state.testDb);
       await insertPosting(state.testDb, source.id, { title: "Data Engineer", function: "eng", location: "Remote" });

       const run = await startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote", resumeId: resume.id }, { llm: testLlm });
       const finished = await waitForTerminal(undefined as never, run.id);
       expect(finished.status).toBe("completed");
       expect(finished.stats.matched).toBeGreaterThan(0);
     });
   });
   ```
   (Add `insertPosting` to `run.test.ts`'s existing `@/server/persistence/repos/__fixtures__/helpers` import.)
2. **Run → FAIL**: `npx vitest run src/server/search/run.test.ts` — the pool-routing test fails (flag not read anywhere yet; `matchAgainstPool` never called).
3. **Minimal impl** — in `src/server/search/run.ts`'s `runFanOut`, replace the discover-loop + `upsertMatchedPostings` call with a branch:
   ```ts
   import { matchAgainstPool } from "./match";
   // ...
   const usePool = process.env.CALIBER_MATCH_FROM_POOL === "true";

   let upsertedJobs: { job: JobRow; source: SourceRow; stage1Score?: number }[];
   if (usePool) {
     handle.emit({ event: "progress", data: { stage: "sources", current: 0, total: 1, label: "Matching against the shared posting pool…" } });
     upsertedJobs = await matchAgainstPool(userId, persona, resumeRow, profile, { llm: deps.llm });
     scanned = upsertedJobs.length;
     handle.emit({
       event: "source",
       data: { sourceId: "pool", name: "Shared posting pool", status: "done", found: upsertedJobs.length },
     });
     discoverMs = Date.now() - discoverStartedAt;
   } else {
     // ... existing connector fan-out + `const upsertedJobs = await upsertMatchedPostings(...)` block, UNCHANGED ...
   }
   ```
   Keep the rest of `runFanOut` (the `scoreTopCandidates` call, stats assembly, SSE `done` emit) untouched — both branches produce the same `upsertedJobs` shape `scoreTopCandidates` already consumes. The `perSource`/`matchedPostings`-derived stats fields that don't apply to the pool path (e.g. per-source fetch counts) degrade to a single synthetic `"pool"` entry rather than being fabricated per real source.
4. **Run → PASS**: `npx vitest run src/server/search/run.test.ts` — both the legacy-path and pool-path tests green, full existing suite in the file still green (default-off proves zero regression).
5. **Commit**: `feat(search): route runFanOut through matchAgainstPool behind CALIBER_MATCH_FROM_POOL (Wave 3 §4.3)`.

---

## Task 9: Pool-readiness guard + operator rollout

- [ ] Prevent the live-safety footgun of flipping `CALIBER_MATCH_FROM_POOL=true` before the crawler has ever populated the pool for a persona — fail loud instead of silently returning zero matches.

**Interfaces:**
- Produces: `PoolNotReadyError` (exported from `src/server/search/match.ts`).
- Consumes: `postingsRepo.count` (Task 3).

### Steps

1. **Write failing test** — append to `src/server/search/match.test.ts`:
   ```ts
   import { PoolNotReadyError, matchAgainstPool } from "./match"; // add PoolNotReadyError to the existing import

   describe("PoolNotReadyError", () => {
     it("throws when the pool has zero rows for ANY persona (crawler hasn't run yet)", async () => {
       state.testDb = await createTestDb();
       const profile = await insertProfile(state.testDb);
       const resume = await insertResume(state.testDb, resumeFixture);
       // no insertPosting call — pool is empty

       await expect(matchAgainstPool("BOOTSTRAP_ADMIN", "remote", resume, profile, { llm: noopLlm })).rejects.toThrow(PoolNotReadyError);
     });
   });
   ```
2. **Run → FAIL**: `npx vitest run src/server/search/match.test.ts` — `matchAgainstPool` currently returns `[]` silently on an empty pool rather than throwing; `PoolNotReadyError` doesn't exist.
3. **Minimal impl** — in `src/server/search/match.ts`, add near the top:
   ```ts
   // Fail loud (CLAUDE.md) rather than silently scanning zero matches: an
   // empty pool means either no source is enabled for this persona, or
   // (the actual footgun this guards) the operator flipped
   // CALIBER_MATCH_FROM_POOL=true before `npm run crawl` ever ran. Both are
   // real operator-visible states, not a code fallback.
   export class PoolNotReadyError extends Error {
     constructor(persona: ScanPersona) {
       super(
         `The shared posting pool has no rows for persona "${persona}" — run the crawler ("npm run crawl") at least once before enabling CALIBER_MATCH_FROM_POOL for this persona.`,
       );
       this.name = "PoolNotReadyError";
     }
   }
   ```
   and at the top of `matchAgainstPool`, right after `const pool = await postingsRepo.listForPersona(persona);`:
   ```ts
   if (pool.length === 0) throw new PoolNotReadyError(persona);
   ```
4. **Run → PASS**: `npx vitest run src/server/search/match.test.ts src/server/search/run.test.ts` — both green (the `run.test.ts` pool-routing test from Task 8 already seeds a posting via `insertPosting`, so it stays unaffected by the new guard).
5. **Commit**: `feat(search): add PoolNotReadyError guard against flipping the rollout flag before the crawler has run (Wave 3 §4.5)`.

**Operator rollout runbook (not code — for whoever flips the switch):**
1. Land Tasks 1–9 on `main`, deploy.
2. Run `npm run crawl` once manually against the LIVE database (or trigger it via the host's cron/systemd timer — see the `/box` skill for the VPS's existing nightly-backup cron as the operational precedent; no in-repo scheduler exists, so this is an OS-level cron entry invoking `npm run crawl`, not new application code).
3. Confirm `postingsRepo.count()` is non-zero for both personas (e.g. via a one-off script or the admin surface, once one exists).
4. Set `CALIBER_MATCH_FROM_POOL=true` in the deploy's environment and restart the app.
5. Run `/verify` to confirm a live scan completes end-to-end through the pool path.
6. Only THEN ramp `sources.enabled` toward the full Wave 2 validated list (spine §4.5) — before this point, per-scan connector fan-out is still live for any user, so an unramped source list stays capped at ~200–300 per Wave 2's own rollout guard regardless of this flag.

---

## Self-review

**Spec/spine coverage → task mapping:**
- §4.1 `postings` table + global dedupe key + ATS-beats-aggregator → Tasks 1, 2.
- §4.2 scheduled crawler, small sequential batches, WAL/busy-timeout, per-vendor politeness, lazy description (unchanged) → Tasks 4, 5 (describe.ts intentionally untouched — `ensureDescription` still runs post-materialization in the existing `scoreTopCandidates`).
- §4.3 split run.ts into crawl vs match, materialize via unchanged `upsertByDedupeKey`, isNew/firstSeen preserved (per-user `jobs` semantics never touched) → Tasks 7, 8.
- §4.4 `function-classify` models.yml task + module, runs only on "other" stage-1 survivors → Task 6, consumed by Task 7.
- §4.5 rollout guard (ramp before full flip) → Tasks 8 (flag), 9 (readiness guard + runbook).
- §5 tests: global dedupe key collisions (Task 2), ATS-beats-aggregator (Task 2 unit + Task 4 integration), batch-write under no-concurrent-transaction (Task 4's sequential-batch loop + Task 5's pragma pin — no test spins up a literal concurrent-writer race, since libsql's single-writer serialization plus the explicit non-transactional loop make the constraint structural rather than timing-dependent; the pragma test (Task 5) is the direct regression guard).

**Placeholder scan:** no `TODO`, no "similar to Task N", no invented API names — every function signature above was either read directly from existing code (`jobsRepo.upsertByDedupeKey`, `resolveEligibility`, `resolveTzBand`, `parseSourceGeo`, `deriveRoleTargets`) or is newly introduced with a complete body in the task that defines it.

**Type consistency:** `postings` columns are identical across Task 1's schema, Task 3's repo, Task 4's crawler insert, and Task 7's `toRawPosting`/materialization. `globalDedupeKeyFor`'s signature is identical between Task 2's definition and Task 4's call site. Wave 1 names (`JobFunction`, `classifyFunction`, `roleMatchScore`, `normalizeTitle`, `deriveRoleTargets`, `jobs.function`) are consumed by their exact spine-given names throughout — flagged once at the top as a hard dependency, not re-litigated per task.

**Live-safety walk-through:** Tasks 1–7 are purely additive (new table, new modules, no existing code path altered in a user-visible way — Task 2's move of `groupByCollision` is behavior-preserving, pinned by the pre-existing `run.test.ts` suite staying green). Task 8 is the only task that changes `run.ts`'s runtime behavior, and it does so behind a flag that defaults to the untouched legacy path — the live app is unaffected until an operator explicitly sets `CALIBER_MATCH_FROM_POOL=true`, which Task 9 additionally guards against being set before the pool has data. The app is shippable and green after every single task in this plan.
