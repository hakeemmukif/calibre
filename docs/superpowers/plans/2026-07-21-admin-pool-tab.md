# Admin Pool tab (static v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/admin/pool` — an admin-only, read-only stats view over the global `postings` pool (composition by job function, timezone band, freshness, company concentration), per `docs/superpowers/specs/2026-07-21-admin-pool-tab-design.md`.

**Architecture:** One new Zod contract (`AdminPoolStats`), one repo aggregate (`poolStatsRepo.getPoolStats`) doing SQL count aggregates for totals/source coverage plus a single light `postings` SELECT reduced once in TS (the hybrid `function_tag`-or-keyword-bucket rule per spec §6 cannot be duplicated in SQL), one `requireAdmin()`-guarded route (`GET /api/admin/pool`), three new caliber-ui compositions (`PoolFunctionCards`, `PoolStrips`, `PoolPanel`) composed from existing primitives, and a page + admin-nav wiring mirroring the existing `/admin/crawl` tab exactly.

**Tech Stack:** Next.js 15 App Router, Drizzle + libsql (SQLite), Zod, Vitest, Storybook, caliber-ui design-system primitives (`src/caliber-ui/components`).

## Global Constraints

- **Fail-loud, no fallback defaults.** Zod validation happens at request/response boundaries only (`Schema.parse` in the route handler, not scattered through repo/UI code). Missing required fields throw — never default to `0`/`""`/`unknown`. (CLAUDE.md; spec §4.)
- **Layering:** UI → `features/*` → `server/*`. Only `server/*` touches the DB. `caliber-ui` compositions never import from `server/*`.
- **Design system:** compose the 13 primitives in `src/caliber-ui/components` (`Card`, `Chip`, `Tag`, `Button`, `Icon`, …) plus kit tokens in `src/caliber-ui/styles/tokens.css`. Never reinvent a primitive. Red accent (`--accent-ink`) used exactly once on this tab — the largest function bucket's numeral (spec §1.3).
- **Zero LLM calls at request time** for this feature — `GET /api/admin/pool` is pure SQL/TS aggregation over already-classified data (spec §5).
- **Static v1 (spec §1):** no history table, no sparkline data, no cross-filter endpoints. The sparkline slot on function cards and the filter-chip row are visually reserved but inert/absent — do not build them, do not stub live wiring for them.
- **Match existing style.** Every file created here mirrors a real sibling file read during planning (cited per-task below) — same import order, same comment density, same naming.
- **No new DB migration.** This feature only reads existing `postings`/`sources` columns; nothing in `src/server/persistence/schema.ts` changes.
- Run `npm run check` (`typecheck && vitest run && contract:check && build`) before the final commit — the exact gate this repo's `.claude` commit hook already runs.

---

## File structure

| File | Responsibility |
|---|---|
| `src/server/pool/functionBucket.ts` | Pure, deterministic keyword→bucket classifier (spec §6). No DB, no I/O. |
| `src/server/pool/functionBucket.test.ts` | Pins the 12-bucket order + the "Head of Engineering" collision case. |
| `src/types/index.ts` (append) | `AdminPoolStats` Zod schema (spec §4). |
| `src/types/index.test.ts` (append) | Contract parse tests for `AdminPoolStats`. |
| `src/server/persistence/repos/poolStats.ts` | `poolStatsRepo.getPoolStats(nowMs)` — the one repo aggregate (spec §5). |
| `src/server/persistence/repos/poolStats.test.ts` | Seeded in-memory SQLite test of the aggregate + hybrid rule. |
| `src/app/api/admin/pool/route.ts` | `GET /api/admin/pool`, `requireAdmin()`-guarded. |
| `src/app/api/admin/pool/route.test.ts` | 401/403/200 tests. |
| `src/contract/registry.ts` (append) | OpenAPI registration for `AdminPoolStats` + the new route (required by `route-coverage.test.ts`). |
| `contract/openapi.json` (regenerated) | Committed OpenAPI doc, regenerated via `npm run contract`. |
| `src/caliber-ui/fixtures/index.ts` (append) | `adminPoolStats` fixture (Storybook + tests). |
| `src/caliber-ui/compositions/Admin/PoolFunctionCards.tsx` (+ `.stories.tsx`) | 12-bucket stat-card grid. |
| `src/caliber-ui/compositions/Admin/PoolStrips.tsx` (+ `.stories.tsx`) | TZ band / freshness / concentration 100%-stacked strips. |
| `src/caliber-ui/compositions/Admin/PoolPanel.tsx` (+ `.stories.tsx`) | Tile row + composes the two above; owns loading/error/empty/populated (the 4 spec §7 states). |
| `src/features/admin/client.ts` (append) | `getPoolStats()` typed client. |
| `src/app/(app)/admin/pool/page.tsx` (+ `.test.tsx`) | The routed page. |
| `src/caliber-ui/compositions/Shell/AppSidebar.tsx` (modify) | Admin nav: add the "Pool" tab. |
| `src/app/AppShell.tsx` (modify) | Route↔nav-id wiring for `/admin/pool`. |
| `docs/architecture/component-inventory.md` (modify) | Document the 3 new compositions. |

---

## Task 1: Keyword-bucket helper (spec §6)

**Files:**
- Create: `src/server/pool/functionBucket.ts`
- Test: `src/server/pool/functionBucket.test.ts`

**Read first (the pattern this mirrors):** `src/server/sources/crawl.ts:46-51` — `isCrawlable(source)`, a small pure exported predicate colocated with the domain it serves, reused (not re-derived) by the repo layer. `functionBucket.ts` is the same shape: a pure function, zero DB, imported by the repo in Task 3.

**Interfaces:**
- Consumes: nothing (pure function, no dependencies on earlier tasks).
- Produces: `FUNCTION_BUCKET_IDS: readonly ["engineering","data","product","design","sales","marketing","cs_support","people_hr","finance_legal","ops_admin","leadership","other"]`, `type FunctionBucket = (typeof FUNCTION_BUCKET_IDS)[number]`, `bucketFromTitle(title: string): FunctionBucket`. Task 3 imports `bucketFromTitle` and `FunctionBucket`.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/pool/functionBucket.test.ts
import { describe, expect, it } from "vitest";
import { bucketFromTitle, FUNCTION_BUCKET_IDS } from "./functionBucket";

describe("bucketFromTitle", () => {
  it("has exactly the 12 pinned buckets in order (spec §6)", () => {
    expect(FUNCTION_BUCKET_IDS).toEqual([
      "engineering", "data", "product", "design", "sales", "marketing",
      "cs_support", "people_hr", "finance_legal", "ops_admin", "leadership", "other",
    ]);
  });

  it("engineering: Senior Backend Engineer", () => {
    expect(bucketFromTitle("Senior Backend Engineer")).toBe("engineering");
  });

  it("data: Data Analyst", () => {
    expect(bucketFromTitle("Data Analyst")).toBe("data");
  });

  it("product: Product Manager", () => {
    expect(bucketFromTitle("Product Manager")).toBe("product");
  });

  it("design: UX Designer", () => {
    expect(bucketFromTitle("UX Designer")).toBe("design");
  });

  it("sales: Account Executive", () => {
    expect(bucketFromTitle("Account Executive")).toBe("sales");
  });

  it("marketing: Growth Marketing Manager", () => {
    expect(bucketFromTitle("Growth Marketing Manager")).toBe("marketing");
  });

  it("cs_support: Customer Success Manager", () => {
    expect(bucketFromTitle("Customer Success Manager")).toBe("cs_support");
  });

  it("people_hr: Talent Acquisition Partner", () => {
    expect(bucketFromTitle("Talent Acquisition Partner")).toBe("people_hr");
  });

  it("finance_legal: Finance Manager", () => {
    expect(bucketFromTitle("Finance Manager")).toBe("finance_legal");
  });

  it("ops_admin: Chief of Staff", () => {
    expect(bucketFromTitle("Chief of Staff")).toBe("ops_admin");
  });

  it("leadership: Director, Corporate Development", () => {
    expect(bucketFromTitle("Director, Corporate Development")).toBe("leadership");
  });

  it("other: Warehouse Associate", () => {
    expect(bucketFromTitle("Warehouse Associate")).toBe("other");
  });

  // Pinned collision case (spec §6, verbatim): "Head of Engineering" matches
  // `engineering` (bucket 1, via "engineer") before it ever reaches
  // `leadership` (bucket 11, via "head of") — first-match-wins by BUCKET
  // ORDER, not substring position. Do not "fix" this into leadership.
  it("PINNED collision: 'Head of Engineering' resolves to engineering, not leadership", () => {
    expect(bucketFromTitle("Head of Engineering")).toBe("engineering");
  });

  it("is case-insensitive", () => {
    expect(bucketFromTitle("SENIOR DEVOPS ENGINEER")).toBe("engineering");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/pool/functionBucket.test.ts`
Expected: FAIL — `Cannot find module './functionBucket'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/server/pool/functionBucket.ts
// Deterministic hybrid function-mix bucketing (Admin Pool tab spec
// 2026-07-21-admin-pool-tab-design.md §6). Per-posting rule (§1.2):
// postings.functionTag when set (P.4 LLM classifier — ~70/18,518 rows as of
// 2026-07-21), else this keyword fallback on the lowercased title.
// First-match-wins by BUCKET ORDER below, not by substring position in the
// title — e.g. "Head of Engineering" matches `engineering` (bucket 1, via
// "engineer") before it ever reaches `leadership` (bucket 11, via "head
// of"). This order is the operator-reviewed classification (spec §8
// calibration) — do not reorder without re-running that calibration.
export const FUNCTION_BUCKET_IDS = [
  "engineering",
  "data",
  "product",
  "design",
  "sales",
  "marketing",
  "cs_support",
  "people_hr",
  "finance_legal",
  "ops_admin",
  "leadership",
  "other",
] as const;

export type FunctionBucket = (typeof FUNCTION_BUCKET_IDS)[number];

// Quoted single-token patterns in the spec (e.g. `"ml "`, `" ai"`, `"ui "`,
// `"hr "`, `"vp "`) are literal substrings INCLUDING the boundary space —
// kept verbatim here, not turned into word-boundary regex, so behavior
// matches the spec's own wording exactly.
const PATTERNS: Record<Exclude<FunctionBucket, "other">, string[]> = {
  engineering: ["engineer", "developer", "devops", "sre", "architect"],
  data: ["data", "analytics", "machine learning", "ml ", " ai", "scientist"],
  product: ["product manager", "product owner", "program manager", "project manager"],
  design: ["design", "ux", "ui "],
  sales: ["sales", "account executive", "account manager", "business development"],
  marketing: ["marketing", "growth", "content", "seo", "brand"],
  cs_support: ["customer success", "support", "customer experience"],
  people_hr: ["recruit", "people", "talent", "hr "],
  finance_legal: ["finance", "accounting", "legal", "counsel", "compliance"],
  ops_admin: ["operations", "office", "executive assistant", "chief of staff"],
  leadership: ["head of", "director", "vp ", "vice president", "chief"],
};

// First-match-wins over FUNCTION_BUCKET_IDS' order (spec §6) — never
// re-sorted by specificity or substring position.
export function bucketFromTitle(title: string): FunctionBucket {
  const lower = title.toLowerCase();
  for (const bucket of FUNCTION_BUCKET_IDS) {
    if (bucket === "other") continue;
    if (PATTERNS[bucket].some((p) => lower.includes(p))) return bucket;
  }
  return "other";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/pool/functionBucket.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/pool/functionBucket.ts src/server/pool/functionBucket.test.ts
git commit -m "$(cat <<'EOF'
feat(admin-pool): pinned keyword-bucket helper for the hybrid function source

Claude-Session: https://claude.ai/code/session_01PfEetLvdfmxSVcT54vtfhf
EOF
)"
```

---

## Task 2: `AdminPoolStats` Zod schema + contract parse test (spec §4)

**Files:**
- Modify: `src/types/index.ts` (append after `AdminCrawlStatus`, currently ending at line 589)
- Test: `src/types/index.test.ts` (append)

**Read first:** `src/types/index.ts:533-589` — `AdminCrawlStatus` and its sub-schemas (`CrawlPoolStatus`, `CrawlRunningStatus`, `CrawlRunSummary`). Same file, same "admin surface schema" comment style. `AdminPoolStats`' nested objects (spec §4's `totals`/`functionMix`/`tzBands`/`freshness`/`concentration`) are kept as inline `z.object({...})` rather than named siblings — unlike `AdminCrawlStatus`'s pieces, none of them are reused by another schema, so a named export would add indirection with no reuse benefit.

**Interfaces:**
- Consumes: nothing new (pure Zod, `z` already imported at the top of `index.ts`).
- Produces: `AdminPoolStats` (Zod schema) and `type AdminPoolStats = z.infer<typeof AdminPoolStats>`, with shape exactly matching spec §4:
  ```ts
  AdminPoolStats {
    totals: { live: number; delisted: number; newLast24h: number; sourcesEnabled: number; sourcesTotal: number; tagCoveragePct: number }
    functionMix: { bucket: string; count: number; share: number; source: "tag" | "keyword" }[]
    tzBands: { band: "americas" | "emea" | "apac" | "unassigned"; count: number; share: number }[]
    freshness: { bucket: "24h" | "2-7d" | "8-30d" | "older"; count: number }[]
    concentration: { topCompanies: { company: string; count: number }[]; top10Count: number; restCount: number }
  }
  ```
  Task 3 (repo) builds a plain object of this shape; Task 4 (route) calls `AdminPoolStats.parse(...)`; Task 5/6 (UI) import it as a type only.

- [ ] **Step 1: Write the failing test**

Append to `src/types/index.test.ts`:

```ts
describe("AdminPoolStats", () => {
  const valid = {
    totals: { live: 100, delisted: 5, newLast24h: 3, sourcesEnabled: 8, sourcesTotal: 10, tagCoveragePct: 0.4 },
    functionMix: [{ bucket: "engineering", count: 40, share: 40, source: "keyword" as const }],
    tzBands: [{ band: "americas" as const, count: 60, share: 60 }],
    freshness: [{ bucket: "24h" as const, count: 3 }],
    concentration: { topCompanies: [{ company: "Acme", count: 10 }], top10Count: 10, restCount: 90 },
  };

  it("parses a well-formed snapshot", () => {
    expect(AdminPoolStats.parse(valid)).toEqual(valid);
  });

  it("throws when totals is missing (fail loud, no fallback defaults)", () => {
    const { totals, ...withoutTotals } = valid;
    expect(() => AdminPoolStats.parse(withoutTotals)).toThrow();
  });

  it("rejects an unknown tzBands.band value", () => {
    expect(() => AdminPoolStats.parse({ ...valid, tzBands: [{ band: "mars", count: 1, share: 1 }] })).toThrow();
  });

  it("rejects an unknown functionMix.source value", () => {
    expect(() =>
      AdminPoolStats.parse({ ...valid, functionMix: [{ bucket: "engineering", count: 1, share: 1, source: "llm" }] }),
    ).toThrow();
  });
});
```

Also add `AdminPoolStats` to the existing `import { ... } from "./index"` (or wherever `index.test.ts` imports schemas from) list at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/types/index.test.ts`
Expected: FAIL — `AdminPoolStats` is not exported / undefined.

- [ ] **Step 3: Write minimal implementation**

Append to `src/types/index.ts`, immediately after the existing block ending `export type AdminCrawlStatus = z.infer<typeof AdminCrawlStatus>;` (line 589):

```ts
// AdminPoolStats — GET /api/admin/pool (Admin Pool tab, spec
// 2026-07-21-admin-pool-tab-design.md §4). Static v1: a single read-only
// snapshot, no history/sparkline series, no cross-filter re-query. Hybrid
// function source (§1.2): postings.function_tag when present (P.4
// classifier), else the deterministic title-keyword bucket
// (src/server/pool/functionBucket.ts) — functionMix[].source reports which
// provenance is the MAJORITY for that bucket's rows (an honesty signal,
// since only ~70/18,518 postings carry a tag as of 2026-07-21). Nested
// objects are kept inline (not named siblings like AdminCrawlStatus's
// pieces) — nothing here is reused by another schema.
export const AdminPoolStats = z.object({
  totals: z.object({
    live: z.number().int(),
    delisted: z.number().int(),
    newLast24h: z.number().int(),
    sourcesEnabled: z.number().int(),
    sourcesTotal: z.number().int(),
    tagCoveragePct: z.number(),
  }),
  functionMix: z.array(
    z.object({
      bucket: z.string(),
      count: z.number().int(),
      share: z.number(),
      source: z.enum(["tag", "keyword"]),
    }),
  ),
  tzBands: z.array(
    z.object({
      band: z.enum(["americas", "emea", "apac", "unassigned"]),
      count: z.number().int(),
      share: z.number(),
    }),
  ),
  freshness: z.array(
    z.object({
      bucket: z.enum(["24h", "2-7d", "8-30d", "older"]),
      count: z.number().int(),
    }),
  ),
  concentration: z.object({
    topCompanies: z.array(z.object({ company: z.string(), count: z.number().int() })),
    top10Count: z.number().int(),
    restCount: z.number().int(),
  }),
});
export type AdminPoolStats = z.infer<typeof AdminPoolStats>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/types/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts src/types/index.test.ts
git commit -m "$(cat <<'EOF'
feat(admin-pool): AdminPoolStats contract schema

Claude-Session: https://claude.ai/code/session_01PfEetLvdfmxSVcT54vtfhf
EOF
)"
```

---

## Task 3: repo aggregate — `poolStatsRepo.getPoolStats` (spec §5, §6)

**Files:**
- Create: `src/server/persistence/repos/poolStats.ts`
- Test: `src/server/persistence/repos/poolStats.test.ts`

**Read first:**
- `src/server/persistence/repos/crawlRuns.ts:37-46` — `getPoolCounts()`: the `count(case when ... then 1 end)` SQL pattern for totals over `postings`, cast `sql<string>` then `Number(...)`. This exact pattern is reused for `totals` and for the `sources` enabled/total count.
- `src/server/persistence/repos/postings.ts:20-38` — `listForMatchingProjection`: a light, explicit column-object SELECT (never `select *`) that deliberately excludes `description`/`raw`/`aliases`. `poolStats.ts`'s `LIVE_PROJECTION` mirrors this shape (title/company/functionTag/tzBand/firstSeenAt only).
- `src/server/persistence/repos/postings.test.ts:1-27` and `crawlRuns.test.ts:1-27` — the local `insertPosting` test helper + `insertSource` from `__fixtures__/helpers.ts`. `poolStats.test.ts` defines its own local `insertPosting` copy (established convention in this codebase — not shared across test files).
- `src/server/persistence/schema.ts:399-441` — `postings` columns: `delistedAt` (null = live), `tzBand` enum `["apac","emea","americas"]` (nullable — null is "unassigned"), `functionTag` (nullable), `firstSeenAt` (`timestamp_ms`, not null), `title`/`company` (not null).
- Spec §6 explicit instruction: the hybrid bucketing "Implement in TS ... not duplicated SQL — one source of truth", so `functionMix` cannot be a SQL `GROUP BY`. Design: totals + source counts stay pure SQL (mirrors `getPoolCounts`); `functionMix`/`tzBands`/`freshness`/`concentration` are computed from ONE light `SELECT ... WHERE delisted_at IS NULL` reduced in a single JS pass — cheap at 18.5k rows (5 short columns each), and the only way to apply `bucketFromTitle` per-row without duplicating it in SQL.
- Per spec §3, `PoolFunctionCards` renders "12 stat cards, one per function bucket" — `functionMix` MUST always contain exactly the 12 `FUNCTION_BUCKET_IDS` entries (zero-count buckets included), not just the buckets that happen to have rows.
- `sourcesEnabled`/`sourcesTotal` count ALL rows in `sources` (including the `manual` pseudo-source) — mirrors `src/app/api/admin/sources/route.ts`'s own `total: rows.length` convention and `crawlRuns.ts`'s `getPerSourceBottom`'s `count(*) from sources`. Not re-litigated here.

**Interfaces:**
- Consumes: `bucketFromTitle`, `FUNCTION_BUCKET_IDS` (Task 1, `@/server/pool/functionBucket`); `type AdminPoolStats` (Task 2, `@/types`); `postings`, `sources` from `../schema`; `Db` from `./db`; `getDb` from `../db`.
- Produces: `createPoolStatsRepo(db: Db)` returning `{ getPoolStats(nowMs: number): Promise<AdminPoolStats> }`, and the wired singleton `poolStatsRepo: { getPoolStats(nowMs: number): Promise<AdminPoolStats> }`. Task 4 imports `poolStatsRepo` and calls `poolStatsRepo.getPoolStats(Date.now())`.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/persistence/repos/poolStats.test.ts
import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { postings } from "../schema";
import type { Db } from "./db";
import { insertSource } from "./__fixtures__/helpers";
import { createPoolStatsRepo } from "./poolStats";

let counter = 0;
async function insertPosting(db: Db, sourceId: string, overrides: Partial<typeof postings.$inferInsert> = {}) {
  counter += 1;
  const key = `ck-pool-${counter}`;
  const [row] = await db
    .insert(postings)
    .values({
      canonicalKey: key,
      url: `https://example.com/${key}`,
      sourceId,
      title: "Senior Backend Engineer",
      company: "Example Co",
      location: "Remote",
      persona: "remote",
      aliases: [],
      raw: {},
      ...overrides,
    })
    .returning();
  return row;
}

function pctExpect(count: number, total: number): number {
  return total === 0 ? 0 : Math.round((count / total) * 1000) / 10;
}

const NOW = new Date("2026-07-21T00:00:00.000Z").getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

describe("poolStatsRepo.getPoolStats", () => {
  it("aggregates totals, source coverage, function mix (hybrid rule), tz bands, freshness, concentration", async () => {
    const db = await createTestDb();
    const repo = createPoolStatsRepo(db);
    const enabledSource = await insertSource(db, { enabled: true });
    const disabledSource = await insertSource(db, { enabled: false });

    // Tagged row — functionTag wins over any keyword guess from the title.
    await insertPosting(db, enabledSource.id, {
      title: "Mystery Role",
      company: "Acme",
      functionTag: "engineering",
      tzBand: "americas",
      firstSeenAt: new Date(NOW - 2 * 60 * 60 * 1000), // 2h ago
    });
    // Untagged row — falls back to the keyword bucket on title.
    await insertPosting(db, enabledSource.id, {
      title: "Data Analyst",
      company: "Acme",
      tzBand: null,
      firstSeenAt: new Date(NOW - 3 * DAY_MS), // 3 days ago
    });
    await insertPosting(db, disabledSource.id, {
      title: "Warehouse Associate",
      company: "Globex",
      tzBand: "emea",
      firstSeenAt: new Date(NOW - 40 * DAY_MS), // older
    });
    // Delisted — excluded from every live aggregate.
    await insertPosting(db, enabledSource.id, {
      title: "Ghost Listing",
      company: "Globex",
      delistedAt: new Date(NOW),
      firstSeenAt: new Date(NOW),
    });

    const stats = await repo.getPoolStats(NOW);

    expect(stats.totals).toEqual({
      live: 3,
      delisted: 1,
      newLast24h: 1,
      sourcesEnabled: 1,
      sourcesTotal: 2,
      tagCoveragePct: pctExpect(1, 3),
    });

    expect(stats.functionMix).toHaveLength(12);
    expect(stats.functionMix.find((m) => m.bucket === "engineering")).toEqual({
      bucket: "engineering", count: 1, share: pctExpect(1, 3), source: "tag",
    });
    expect(stats.functionMix.find((m) => m.bucket === "data")).toEqual({
      bucket: "data", count: 1, share: pctExpect(1, 3), source: "keyword",
    });
    expect(stats.functionMix.find((m) => m.bucket === "other")).toEqual({
      bucket: "other", count: 1, share: pctExpect(1, 3), source: "keyword",
    });

    expect(stats.tzBands).toEqual([
      { band: "americas", count: 1, share: pctExpect(1, 3) },
      { band: "emea", count: 1, share: pctExpect(1, 3) },
      { band: "apac", count: 0, share: 0 },
      { band: "unassigned", count: 1, share: pctExpect(1, 3) },
    ]);

    expect(stats.freshness).toEqual([
      { bucket: "24h", count: 1 },
      { bucket: "2-7d", count: 1 },
      { bucket: "8-30d", count: 0 },
      { bucket: "older", count: 1 },
    ]);

    expect(stats.concentration.topCompanies).toEqual([
      { company: "Acme", count: 2 },
      { company: "Globex", count: 1 },
    ]);
    expect(stats.concentration.top10Count).toBe(3);
    expect(stats.concentration.restCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/persistence/repos/poolStats.test.ts`
Expected: FAIL — `Cannot find module './poolStats'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/server/persistence/repos/poolStats.ts
// Admin Pool tab aggregate (spec 2026-07-21-admin-pool-tab-design.md §5).
// GLOBAL-BY-DECISION: postings/sources are system-owned (no userId) — same
// dimension as crawlRuns.ts's admin surfaces. Totals + source coverage are
// plain SQL count aggregates (mirrors crawlRuns.ts's getPoolCounts).
// functionMix/tzBands/freshness/concentration ride ONE light SELECT over
// live rows (title/company/functionTag/tzBand/firstSeenAt — no description,
// mirrors postings.ts's listForMatching read-amplification discipline)
// reduced in a single JS pass: spec §6 requires the hybrid function-source
// rule to live in ONE TS helper, never duplicated as SQL.
import { isNull, sql } from "drizzle-orm";
import { bucketFromTitle, FUNCTION_BUCKET_IDS } from "@/server/pool/functionBucket";
import type { AdminPoolStats } from "@/types";
import { getDb } from "../db";
import { postings, sources } from "../schema";
import type { Db } from "./db";

const DAY_MS = 24 * 60 * 60 * 1000;

const LIVE_PROJECTION = {
  title: postings.title,
  company: postings.company,
  functionTag: postings.functionTag,
  tzBand: postings.tzBand,
  firstSeenAt: postings.firstSeenAt,
} as const;

function pct(count: number, total: number): number {
  return total === 0 ? 0 : Math.round((count / total) * 1000) / 10;
}

export function createPoolStatsRepo(db: Db) {
  return {
    async getPoolStats(nowMs: number): Promise<AdminPoolStats> {
      const [totalsRow] = await db
        .select({
          live: sql<string>`count(case when ${postings.delistedAt} is null then 1 end)`,
          delisted: sql<string>`count(case when ${postings.delistedAt} is not null then 1 end)`,
          newLast24h: sql<string>`count(case when ${postings.delistedAt} is null and ${postings.firstSeenAt} >= ${new Date(nowMs - DAY_MS)} then 1 end)`,
          tagged: sql<string>`count(case when ${postings.delistedAt} is null and ${postings.functionTag} is not null then 1 end)`,
        })
        .from(postings);

      // Same convention as admin/sources/route.ts's `total: rows.length` and
      // crawlRuns.ts's getPerSourceBottom: counts every sources row,
      // including the `manual` pseudo-source — not re-litigated here.
      const [sourcesRow] = await db
        .select({
          total: sql<string>`count(*)`,
          enabled: sql<string>`count(case when ${sources.enabled} = 1 then 1 end)`,
        })
        .from(sources);

      const liveRows = await db.select(LIVE_PROJECTION).from(postings).where(isNull(postings.delistedAt));
      const live = Number(totalsRow.live);

      const bucketAgg = new Map<string, { count: number; tag: number; keyword: number }>();
      const tzCounts = new Map<string, number>();
      const freshCounts = new Map<"24h" | "2-7d" | "8-30d" | "older", number>();
      const companyCounts = new Map<string, number>();

      for (const row of liveRows) {
        const bucket = row.functionTag ?? bucketFromTitle(row.title);
        const provenance: "tag" | "keyword" = row.functionTag ? "tag" : "keyword";
        const entry = bucketAgg.get(bucket) ?? { count: 0, tag: 0, keyword: 0 };
        entry.count += 1;
        entry[provenance] += 1;
        bucketAgg.set(bucket, entry);

        const tzBand = row.tzBand ?? "unassigned";
        tzCounts.set(tzBand, (tzCounts.get(tzBand) ?? 0) + 1);

        const ageMs = nowMs - row.firstSeenAt.getTime();
        const freshBucket =
          ageMs <= DAY_MS ? "24h" : ageMs <= 7 * DAY_MS ? "2-7d" : ageMs <= 30 * DAY_MS ? "8-30d" : "older";
        freshCounts.set(freshBucket, (freshCounts.get(freshBucket) ?? 0) + 1);

        companyCounts.set(row.company, (companyCounts.get(row.company) ?? 0) + 1);
      }

      // spec §3: PoolFunctionCards renders exactly the 12 pinned buckets,
      // zero-count ones included — never just "the buckets seen in data".
      const functionMix = FUNCTION_BUCKET_IDS.map((bucket) => {
        const agg = bucketAgg.get(bucket) ?? { count: 0, tag: 0, keyword: 0 };
        return {
          bucket,
          count: agg.count,
          share: pct(agg.count, live),
          source: (agg.tag >= agg.keyword ? "tag" : "keyword") as "tag" | "keyword",
        };
      });

      const tzBands = (["americas", "emea", "apac", "unassigned"] as const).map((band) => ({
        band,
        count: tzCounts.get(band) ?? 0,
        share: pct(tzCounts.get(band) ?? 0, live),
      }));

      const freshness = (["24h", "2-7d", "8-30d", "older"] as const).map((bucket) => ({
        bucket,
        count: freshCounts.get(bucket) ?? 0,
      }));

      const topCompanies = [...companyCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([company, count]) => ({ company, count }));
      const top10Count = topCompanies.reduce((sum, c) => sum + c.count, 0);

      return {
        totals: {
          live,
          delisted: Number(totalsRow.delisted),
          newLast24h: Number(totalsRow.newLast24h),
          sourcesEnabled: Number(sourcesRow.enabled),
          sourcesTotal: Number(sourcesRow.total),
          tagCoveragePct: pct(Number(totalsRow.tagged), live),
        },
        functionMix,
        tzBands,
        freshness,
        concentration: { topCompanies, top10Count, restCount: live - top10Count },
      };
    },
  };
}

export const poolStatsRepo: ReturnType<typeof createPoolStatsRepo> = {
  getPoolStats: (nowMs) => createPoolStatsRepo(getDb()).getPoolStats(nowMs),
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/persistence/repos/poolStats.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/persistence/repos/poolStats.ts src/server/persistence/repos/poolStats.test.ts
git commit -m "$(cat <<'EOF'
feat(admin-pool): poolStatsRepo.getPoolStats aggregate over postings/sources

Claude-Session: https://claude.ai/code/session_01PfEetLvdfmxSVcT54vtfhf
EOF
)"
```

---

## Task 4: `GET /api/admin/pool` route + contract wiring (spec §2, §5)

**Files:**
- Create: `src/app/api/admin/pool/route.ts`
- Test: `src/app/api/admin/pool/route.test.ts`
- Modify: `src/contract/registry.ts` (import list, `entitySchemas` map, new `registerPath`)
- Regenerate: `contract/openapi.json`

**Read first:**
- `src/app/api/admin/sources/route.ts` (full file, already read) — the `requireAdmin()` + `try/catch (UnauthorizedError | ForbiddenError)` + `errorResponse(status, code, message)` shape. This route mirrors it exactly, minus the row-level degrade logic (Pool's aggregate has no per-row failure mode to degrade).
- `src/app/api/admin/crawl/route.ts:34-42` — the same `errorResponse` helper (duplicated per-route in this codebase, not shared — matched here).
- `src/app/api/admin/sources/route.test.ts:1-42` — the `vi.hoisted` mock of `requireAdmin` + `createTestDb`-backed `getDb` mock, and the 401/403 test shape. `route.test.ts` mirrors this exactly.
- `src/contract/registry.ts:761-792` — the `/api/admin/users`, `/api/admin/sources`, `/api/admin/crawl` `registerPath` blocks: `method: "get"`, a `summary`, `responses: { 200, 401, 403 }`. The new `/api/admin/pool` block is inserted directly after the `/api/admin/crawl` block (after line 792).
- `src/contract/route-coverage.test.ts` — asserts every `route.ts` on disk has a matching `registerPath` entry (except `/api/docs`). Skipping the registry step fails this test under `npm run check`.
- `package.json`: `"contract": "tsx src/contract/generate.ts"` regenerates `contract/openapi.json`; `"contract:check"` (part of `npm run check`) fails if the committed file is stale.

**Interfaces:**
- Consumes: `requireAdmin`, `ForbiddenError`, `UnauthorizedError` (`@/server/auth/session`, `@/server/auth/errors`); `poolStatsRepo.getPoolStats(nowMs: number): Promise<AdminPoolStats>` (Task 3); `AdminPoolStats` schema + `ErrorEnvelope` type (Task 2, `@/types`).
- Produces: `GET /api/admin/pool` → `200 AdminPoolStats | 401 ErrorEnvelope | 403 ErrorEnvelope`. Task 7's `features/admin/client.ts` calls this path.

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/admin/pool/route.test.ts
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/errors";
import { postings, sources } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { requireAdmin } = vi.hoisted(() => ({ requireAdmin: vi.fn() }));
vi.mock("@/server/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/server/auth/session")>()),
  requireAdmin: () => requireAdmin(),
}));

const { GET } = await import("./route");

describe("GET /api/admin/pool", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  beforeEach(() => {
    requireAdmin.mockReset();
    requireAdmin.mockResolvedValue({ id: "admin-1", email: "admin@example.com", role: "admin" });
  });

  afterEach(async () => {
    await state.testDb.delete(postings);
    await state.testDb.delete(sources);
  });

  it("401s with UNAUTHORIZED when there is no session", async () => {
    requireAdmin.mockRejectedValue(new UnauthorizedError());
    const res = await GET();
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("403s with FORBIDDEN for a normal (non-admin) user", async () => {
    requireAdmin.mockRejectedValue(new ForbiddenError());
    const res = await GET();
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
  });

  it("200s for an admin with an empty pool", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totals).toEqual({
      live: 0, delisted: 0, newLast24h: 0, sourcesEnabled: 0, sourcesTotal: 0, tagCoveragePct: 0,
    });
    expect(body.functionMix).toHaveLength(12);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/admin/pool/route.test.ts`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/app/api/admin/pool/route.ts
// GET /api/admin/pool — Admin Pool tab (spec 2026-07-21-admin-pool-tab-
// design.md §5): a read-only snapshot of the global postings pool's
// composition (function mix, tz bands, freshness, company concentration).
// requireAdmin()-guarded, mirrors admin/sources/route.ts's shape. ZERO LLM
// calls; one repo aggregate (poolStatsRepo.getPoolStats) over
// postings/sources.
import { NextResponse } from "next/server";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/errors";
import { requireAdmin } from "@/server/auth/session";
import { poolStatsRepo } from "@/server/persistence/repos/poolStats";
import { AdminPoolStats } from "@/types";
import type { ErrorEnvelope } from "@/types";

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string) {
  const body: ErrorEnvelope = { error: { code, message } };
  return NextResponse.json(body, { status });
}

export async function GET() {
  try {
    await requireAdmin();
    const stats = await poolStatsRepo.getPoolStats(Date.now());
    return NextResponse.json(AdminPoolStats.parse(stats), { status: 200 });
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    if (err instanceof ForbiddenError) return errorResponse(403, "FORBIDDEN", err.message);
    throw err;
  }
}
```

Now wire the contract. In `src/contract/registry.ts`:

1. In the `import { ... } from "@/types"` block (line 26-75), add `AdminPoolStats,` immediately after `AdminCrawlStatus,` (line 74).
2. In the `entitySchemas` map (line 77-126), add `AdminPoolStats,` immediately after `AdminCrawlStatus,` (line 125).
3. Immediately after the `/api/admin/crawl` `registerPath` block (ends line 792), insert:

```ts
registry.registerPath({
  method: "get",
  path: "/api/admin/pool",
  summary: "Admin: Pool tab — postings-pool composition (function mix, tz bands, freshness, company concentration)",
  responses: {
    200: { description: "Pool stats snapshot (static v1 — no history/sparkline series)", content: { "application/json": { schema: AdminPoolStats } } },
    401: { description: "No session", content: { "application/json": { schema: ErrorEnvelope } } },
    403: { description: "Caller is not an admin", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});
```

- [ ] **Step 4: Run test to verify it passes, then regenerate the contract**

Run: `npx vitest run src/app/api/admin/pool/route.test.ts`
Expected: PASS.

Run: `npm run contract`
Expected: `contract/openapi.json` is rewritten (git diff shows the new `/api/admin/pool` path + `AdminPoolStats` component).

Run: `npx vitest run src/contract`
Expected: PASS — `route-coverage.test.ts` no longer reports `/api/admin/pool` as unregistered.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/admin/pool/route.ts src/app/api/admin/pool/route.test.ts src/contract/registry.ts contract/openapi.json
git commit -m "$(cat <<'EOF'
feat(admin-pool): GET /api/admin/pool route + OpenAPI registration

Claude-Session: https://claude.ai/code/session_01PfEetLvdfmxSVcT54vtfhf
EOF
)"
```

---

## Task 5: `PoolFunctionCards` + `PoolStrips` compositions (spec §3)

**Files:**
- Create: `src/caliber-ui/compositions/Admin/PoolFunctionCards.tsx` (+ `.stories.tsx`)
- Create: `src/caliber-ui/compositions/Admin/PoolStrips.tsx` (+ `.stories.tsx`)
- Modify: `src/caliber-ui/fixtures/index.ts` (append `adminPoolStats` fixture)

**Read first:**
- `src/caliber-ui/compositions/Feed/SummaryStrip.tsx` (full file, already read) — the "whole-contract-object prop, Card padding/flex-cells" idiom `PoolFunctionCards`' individual cards riff on.
- `src/caliber-ui/components/FitBar.tsx` (full file, already read) — the rounded-pill-track geometry (`height`, `border-radius: var(--radius-bar, 999px)`, `background: var(--surface-sunken)`) `PoolStrips` reuses for its stacked bar. FitBar itself is NOT imported/reused as a component here: its API is one `value`/`tone` pair, it cannot express multiple stacked segments — `PoolStrips` builds a bespoke multi-segment bar with the same geometry, not the same component.
- `src/caliber-ui/components/Chip.tsx` (full file, already read) — used undecorated (no `onClick`) as inert legend chips below each strip, per spec §3's "Chip legends".
- `src/caliber-ui/compositions/Admin/AdminUsersTable.stories.tsx` (full file, already read) — the Storybook `Meta`/`title: "Compositions/Admin/..."`/`StoryObj` shape.
- `src/caliber-ui/fixtures/index.ts:1-20, tail` — every export is `Schema.parse(...)`-validated at module load, real (non-lorem) content. `adminPoolStats` mirrors this: `AdminPoolStats.parse({...})` with real company names (Stripe, GitLab, Automattic, Doist, Grab, Canva, Zapier, Toptal, Remote.com, Deel), figures loosely proportioned from spec §8's real snapshot but NOT a literal copy (§8 explicitly says "calibration only — not fixture data").
- `docs/architecture/component-inventory.md:19` — the tier→tone mapping rule ("never hand-pick tones") doesn't apply here (function buckets aren't a legitimacy/eligibility tier), but confirms the "compose primitives, whole contract objects as props" house rule this task follows.

**Interfaces:**
- Consumes: `type AdminPoolStats` (Task 2, `@/types` — imported as `../../../types` from `caliber-ui/compositions/Admin/`); `Card` (`../../components/Card`); `Chip` (`../../components/Chip`).
- Produces: `PoolFunctionCards({ mix: AdminPoolStats["functionMix"] })`; `PoolStrips({ tzBands: AdminPoolStats["tzBands"], freshness: AdminPoolStats["freshness"], concentration: AdminPoolStats["concentration"] })`. Task 6 (`PoolPanel`) imports and composes both. `adminPoolStats: AdminPoolStats` fixture is consumed by both `.stories.tsx` files and by Task 6's stories.

- [ ] **Step 1: Add the fixture (no test — fixtures are validated by their own `Schema.parse` at import time, per this file's existing convention)**

Add `AdminPoolStats` to the `import { ... } from "../../types"` block at the top of `src/caliber-ui/fixtures/index.ts`, then append near the end of the file (after the `sources` export):

```ts
// ---------------------------------------------------------------------------
// Admin Pool tab — a snapshot loosely proportioned from spec §8's real
// 2026-07-21 numbers, scaled down. NOT the live data (spec §8: "calibration
// only, not fixture data") — just realistic company names and proportions.
// ---------------------------------------------------------------------------

export const adminPoolStats: AdminPoolStats = AdminPoolStats.parse({
  totals: { live: 5000, delisted: 300, newLast24h: 120, sourcesEnabled: 620, sourcesTotal: 816, tagCoveragePct: 0.4 },
  functionMix: [
    { bucket: "engineering", count: 1715, share: 34.3, source: "tag" },
    { bucket: "other", count: 1022, share: 20.4, source: "keyword" },
    { bucket: "sales", count: 735, share: 14.7, source: "keyword" },
    { bucket: "marketing", count: 242, share: 4.8, source: "keyword" },
    { bucket: "product", count: 218, share: 4.4, source: "keyword" },
    { bucket: "data", count: 218, share: 4.4, source: "keyword" },
    { bucket: "ops_admin", count: 183, share: 3.7, source: "keyword" },
    { bucket: "cs_support", count: 157, share: 3.1, source: "keyword" },
    { bucket: "finance_legal", count: 148, share: 3.0, source: "keyword" },
    { bucket: "design", count: 133, share: 2.7, source: "keyword" },
    { bucket: "leadership", count: 117, share: 2.3, source: "keyword" },
    { bucket: "people_hr", count: 112, share: 2.2, source: "keyword" },
  ],
  tzBands: [
    { band: "americas", count: 2460, share: 49.2 },
    { band: "unassigned", count: 1230, share: 24.6 },
    { band: "emea", count: 745, share: 14.9 },
    { band: "apac", count: 565, share: 11.3 },
  ],
  freshness: [
    { bucket: "24h", count: 120 },
    { bucket: "2-7d", count: 680 },
    { bucket: "8-30d", count: 1600 },
    { bucket: "older", count: 2600 },
  ],
  concentration: {
    topCompanies: [
      { company: "Stripe", count: 277 },
      { company: "GitLab", count: 140 },
      { company: "Automattic", count: 120 },
      { company: "Doist", count: 98 },
      { company: "Grab", count: 85 },
      { company: "Canva", count: 74 },
      { company: "Zapier", count: 66 },
      { company: "Toptal", count: 58 },
      { company: "Remote.com", count: 52 },
      { company: "Deel", count: 47 },
    ],
    top10Count: 1017,
    restCount: 3983,
  },
});
```

- [ ] **Step 2: Write `PoolFunctionCards` (no separate test — Storybook renders it; behavior is covered end-to-end by `poolStats.test.ts`'s data shape)**

```tsx
// src/caliber-ui/compositions/Admin/PoolFunctionCards.tsx
"use client";
import * as React from "react";
import { Card } from "../../components/Card";
import type { AdminPoolStats } from "../../../types";

const BUCKET_LABELS: Record<string, string> = {
  engineering: "Engineering",
  data: "Data",
  product: "Product",
  design: "Design",
  sales: "Sales",
  marketing: "Marketing",
  cs_support: "CS & Support",
  people_hr: "People & HR",
  finance_legal: "Finance & Legal",
  ops_admin: "Ops & Admin",
  leadership: "Leadership",
  other: "Other",
};

export interface PoolFunctionCardsProps {
  mix: AdminPoolStats["functionMix"];
}

// PoolFunctionCards — grid of 12 stat cards, one per function bucket (spec
// §3/§4): eyebrow label, --type-h1 tabular count, "N% of pool" caption. The
// largest bucket's numeral goes in --accent-ink with a --border-strong top
// rule — the one place the red brand accent appears on this tab (spec
// §1.3). The sparkline slot below the count is intentionally empty in v1
// (spec §1.1 static-v1: visually reserved, wired later without rework).
export function PoolFunctionCards({ mix }: PoolFunctionCardsProps) {
  const maxCount = mix.reduce((m, b) => Math.max(m, b.count), 0);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
      {mix.map((b) => {
        const isLargest = b.count === maxCount && maxCount > 0;
        return (
          <Card key={b.bucket} padding="sm" style={isLargest ? { borderTop: "2px solid var(--border-strong)" } : undefined}>
            <div
              style={{
                font: "var(--type-eyebrow)",
                color: "var(--text-muted)",
                textTransform: "uppercase",
                letterSpacing: "var(--tracking-caps)",
              }}
            >
              {BUCKET_LABELS[b.bucket] ?? b.bucket}
            </div>
            <div
              style={{
                font: "var(--type-h1)",
                color: isLargest ? "var(--accent-ink)" : "var(--text-strong)",
                fontVariantNumeric: "tabular-nums",
                marginTop: 4,
              }}
            >
              {b.count.toLocaleString()}
            </div>
            <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 2 }}>
              {b.share}% of pool
            </div>
            {/* Sparkline slot — reserved-empty in static v1 (spec §1.1) */}
            <div style={{ height: 20, marginTop: 8 }} />
          </Card>
        );
      })}
    </div>
  );
}
```

```tsx
// src/caliber-ui/compositions/Admin/PoolFunctionCards.stories.tsx
import type { Meta, StoryObj } from "@storybook/react";
import { PoolFunctionCards } from "./PoolFunctionCards";
import { adminPoolStats } from "../../fixtures";

const meta: Meta<typeof PoolFunctionCards> = {
  title: "Compositions/Admin/PoolFunctionCards",
  component: PoolFunctionCards,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof PoolFunctionCards>;

export const Populated: Story = {
  args: { mix: adminPoolStats.functionMix },
};
```

- [ ] **Step 3: Write `PoolStrips`**

```tsx
// src/caliber-ui/compositions/Admin/PoolStrips.tsx
"use client";
import * as React from "react";
import { Chip } from "../../components/Chip";
import type { AdminPoolStats } from "../../../types";

interface StripSegment {
  key: string;
  label: string;
  count: number;
  share: number;
  color: string;
}

const PALETTE = ["var(--fit-strong)", "var(--fit-mid)", "var(--accent-ink)", "var(--text-strong)", "var(--fit-weak)"];
const OTHER_COLOR = "var(--neutral-300)";
const INLINE_LABEL_MIN_SHARE = 4;

// Segments < 4% share (spec §3c) collapse into a trailing "Other" segment —
// the strip stays readable instead of a wall of slivers.
function collapseSmall(segments: StripSegment[]): StripSegment[] {
  const big = segments.filter((s) => s.share >= INLINE_LABEL_MIN_SHARE);
  const small = segments.filter((s) => s.share < INLINE_LABEL_MIN_SHARE);
  if (small.length === 0) return big;
  const other = small.reduce(
    (acc, s) => ({ ...acc, count: acc.count + s.count, share: acc.share + s.share }),
    { key: "other", label: "Other", count: 0, share: 0, color: OTHER_COLOR },
  );
  return [...big, other];
}

// Strip — a 100%-stacked bar (FitBar's rounded-track geometry, not the FitBar
// component itself — FitBar only expresses one value/tone pair) + a Chip
// legend row underneath (spec §3: "Chip legends").
function Strip({ title, segments }: { title: string; segments: StripSegment[] }) {
  const collapsed = collapseSmall(segments);
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ font: "var(--type-h3)", color: "var(--text-strong)", marginBottom: 8 }}>{title}</div>
      <div
        style={{
          display: "flex",
          height: 10,
          borderRadius: "var(--radius-bar, 999px)",
          overflow: "hidden",
          background: "var(--surface-sunken)",
        }}
      >
        {collapsed.map((s) => (
          <div key={s.key} title={`${s.label}: ${s.share}%`} style={{ width: `${s.share}%`, background: s.color }} />
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
        {collapsed.map((s) => (
          <Chip key={s.key} style={{ cursor: "default" }}>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 999, background: s.color, marginRight: 2 }} />
            {s.label} {s.share}%
          </Chip>
        ))}
      </div>
    </div>
  );
}

const TZ_LABELS: Record<string, string> = { americas: "Americas", emea: "EMEA", apac: "APAC", unassigned: "Unassigned" };
const FRESHNESS_LABELS: Record<string, string> = {
  "24h": "Last 24h",
  "2-7d": "2–7 days",
  "8-30d": "8–30 days",
  older: "Older",
};

function sharePct(count: number, total: number): number {
  return total === 0 ? 0 : Math.round((count / total) * 1000) / 10;
}

export interface PoolStripsProps {
  tzBands: AdminPoolStats["tzBands"];
  freshness: AdminPoolStats["freshness"];
  concentration: AdminPoolStats["concentration"];
}

// PoolStrips — three full-width 100%-stacked strips (spec §3): TZ band,
// freshness, and company concentration. `unassigned` always renders in
// --neutral-300 (spec §3a). freshness/concentration carry no per-entry
// `share` in the contract (spec §4) — computed client-side here from counts.
export function PoolStrips({ tzBands, freshness, concentration }: PoolStripsProps) {
  const tzSegments: StripSegment[] = tzBands.map((b, i) => ({
    key: b.band,
    label: TZ_LABELS[b.band] ?? b.band,
    count: b.count,
    share: b.share,
    color: b.band === "unassigned" ? OTHER_COLOR : PALETTE[i % PALETTE.length],
  }));

  const freshTotal = freshness.reduce((sum, f) => sum + f.count, 0);
  const freshSegments: StripSegment[] = freshness.map((f, i) => ({
    key: f.bucket,
    label: FRESHNESS_LABELS[f.bucket] ?? f.bucket,
    count: f.count,
    share: sharePct(f.count, freshTotal),
    color: PALETTE[i % PALETTE.length],
  }));

  const concentrationTotal = concentration.top10Count + concentration.restCount;
  const concentrationSegments: StripSegment[] = [
    ...concentration.topCompanies.map((c, i) => ({
      key: c.company,
      label: c.company,
      count: c.count,
      share: sharePct(c.count, concentrationTotal),
      color: PALETTE[i % PALETTE.length],
    })),
    {
      key: "rest",
      label: "Rest of pool",
      count: concentration.restCount,
      share: sharePct(concentration.restCount, concentrationTotal),
      color: OTHER_COLOR,
    },
  ];

  return (
    <div>
      <Strip title="Timezone band" segments={tzSegments} />
      <Strip title="Freshness" segments={freshSegments} />
      <Strip title="Company concentration" segments={concentrationSegments} />
    </div>
  );
}
```

```tsx
// src/caliber-ui/compositions/Admin/PoolStrips.stories.tsx
import type { Meta, StoryObj } from "@storybook/react";
import { PoolStrips } from "./PoolStrips";
import { adminPoolStats } from "../../fixtures";

const meta: Meta<typeof PoolStrips> = {
  title: "Compositions/Admin/PoolStrips",
  component: PoolStrips,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof PoolStrips>;

export const Populated: Story = {
  args: {
    tzBands: adminPoolStats.tzBands,
    freshness: adminPoolStats.freshness,
    concentration: adminPoolStats.concentration,
  },
};
```

- [ ] **Step 4: Verify typecheck + Storybook build**

Run: `npx tsc --noEmit`
Expected: PASS (no type errors in the new files or `fixtures/index.ts`).

Run: `npx vitest run src/caliber-ui/fixtures`
Expected: PASS (no existing fixtures test breaks — if a dedicated fixtures test file doesn't exist, this is a no-op; confirm with `find src/caliber-ui/fixtures -name '*.test.ts'` first).

- [ ] **Step 5: Commit**

```bash
git add src/caliber-ui/fixtures/index.ts src/caliber-ui/compositions/Admin/PoolFunctionCards.tsx src/caliber-ui/compositions/Admin/PoolFunctionCards.stories.tsx src/caliber-ui/compositions/Admin/PoolStrips.tsx src/caliber-ui/compositions/Admin/PoolStrips.stories.tsx
git commit -m "$(cat <<'EOF'
feat(admin-pool): PoolFunctionCards + PoolStrips compositions

Claude-Session: https://claude.ai/code/session_01PfEetLvdfmxSVcT54vtfhf
EOF
)"
```

---

## Task 6: `PoolPanel` composition — tile row + the 4 spec states (spec §3, §7)

**Files:**
- Create: `src/caliber-ui/compositions/Admin/PoolPanel.tsx` (+ `.stories.tsx`)

**Read first:**
- `src/caliber-ui/compositions/Feed/JobFeed.tsx` (full file, already read) — the precedent for a composition that owns its OWN `loading`/`error`/`onRetry` branching internally (unlike `CrawlPanel`, which assumes the page already resolved `data` and has no Storybook file at all). `component-inventory.md`'s row for `JobFeed` lists exactly "loading skeleton / empty / error+retry / populated" — the same 4 states spec §7 requires for the Pool tab — so `PoolPanel` mirrors `JobFeed`'s shape (skeleton block while `loading`, `Icon`+message+`Button` retry on `error`, empty-state message, then the populated composition), not `CrawlPanel`'s (page-owns-state, no stories).
- `src/caliber-ui/compositions/Feed/JobFeed.stories.tsx` (full file, already read) — the `Loading`/`Empty`/`ErrorWithRetry`/`Populated` story shape, including a locally-defined zero-value constant (`zeroStats`) for the `Loading`/`Empty` stories rather than reusing the shared fixture. `PoolPanel.stories.tsx` defines its own local `emptyPoolStats` the same way.
- `src/caliber-ui/compositions/Feed/SummaryStrip.tsx` (full file, already read) — the tile-row idiom (`Card padding="none" elevation="none"` background `--surface-sunken`, flex cells with `borderLeft` separators, tabular numerals). Spec §3 names this "SummaryStrip idiom" explicitly; not extracted as a separate component since spec §3 doesn't name a `PoolTiles` component (only `PoolFunctionCards`/`PoolStrips` are named) — kept as a local, unexported `TileRow` inside `PoolPanel.tsx`.

**Interfaces:**
- Consumes: `PoolFunctionCards`, `PoolStrips` (Task 5, same directory); `Card`, `Icon`, `Button` (`../../components/*`); `type AdminPoolStats` (Task 2, `@/types`); `adminPoolStats` fixture (Task 5) for the `Populated` story.
- Produces: `PoolPanel({ stats?: AdminPoolStats; loading: boolean; error?: string; onRetry?(): void })`. Task 7's page imports `PoolPanel` and wires it to `getPoolStats()`.

- [ ] **Step 1: Write `PoolPanel`**

(No separate `.test.ts` — this is a presentational composition verified via Storybook, exactly like `JobFeed`/`AdminUsersTable`/`CrawlPanel`, none of which have a `.test.tsx`; page-level behavior — forbidden/error/retry — IS unit-tested in Task 7's `page.test.tsx`.)

```tsx
// src/caliber-ui/compositions/Admin/PoolPanel.tsx
"use client";
import * as React from "react";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Icon } from "../../components/Icon";
import { PoolFunctionCards } from "./PoolFunctionCards";
import { PoolStrips } from "./PoolStrips";
import type { AdminPoolStats } from "../../../types";

export interface PoolPanelProps {
  stats?: AdminPoolStats;
  loading: boolean;
  error?: string;
  onRetry?(): void;
}

function TileRow({ totals }: { totals: AdminPoolStats["totals"] }) {
  const cells = [
    { label: "Live postings", value: totals.live.toLocaleString() },
    { label: "Delisted", value: totals.delisted.toLocaleString() },
    { label: "New last 24h", value: totals.newLast24h.toLocaleString() },
    { label: "Boards (enabled/total)", value: `${totals.sourcesEnabled}/${totals.sourcesTotal}` },
    { label: "Function-tag coverage", value: `${totals.tagCoveragePct}%` },
  ];
  return (
    <Card padding="none" elevation="none" style={{ background: "var(--surface-sunken)", border: "none", marginBottom: 20 }}>
      <div style={{ display: "flex" }}>
        {cells.map((c, i) => (
          <div key={c.label} style={{ flex: 1, padding: "16px 20px", borderLeft: i > 0 ? "1px solid var(--border)" : "none" }}>
            <div style={{ font: "700 26px/1 var(--font-display)", color: "var(--text-strong)", fontVariantNumeric: "tabular-nums" }}>
              {c.value}
            </div>
            <div style={{ font: "var(--type-caption)", color: "var(--text-muted)", marginTop: 4 }}>{c.label}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// PoolPanel — the Admin Pool tab body (spec 2026-07-21-admin-pool-tab-
// design.md §3): tile row + PoolFunctionCards + PoolStrips. Owns its own
// loading/error/empty/populated states (mirrors JobFeed, not CrawlPanel) —
// this is the composition spec §7's 4 Storybook states are storied against.
export function PoolPanel({ stats, loading, error, onRetry }: PoolPanelProps) {
  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            style={{
              height: 88,
              borderRadius: "var(--radius-lg)",
              background: "var(--surface-sunken)",
              animation: "caliber-pulse 1.1s ease-in-out infinite alternate",
            }}
          />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "40px 20px", textAlign: "center" }}>
        <Icon name="triangle-alert" size={22} style={{ color: "var(--danger-ink)" }} />
        <span style={{ font: "var(--type-body)", color: "var(--text-body)" }}>{error}</span>
        <Button variant="secondary" onClick={onRetry} iconLeft="refresh-cw">
          Retry
        </Button>
      </div>
    );
  }

  if (!stats || stats.totals.live === 0) {
    return (
      <div style={{ padding: "40px 20px", textAlign: "center", font: "var(--type-body)", color: "var(--text-muted)" }}>
        Pool is empty — nothing crawled yet.
      </div>
    );
  }

  return (
    <div>
      <TileRow totals={stats.totals} />
      <PoolFunctionCards mix={stats.functionMix} />
      <div style={{ marginTop: 24 }}>
        <PoolStrips tzBands={stats.tzBands} freshness={stats.freshness} concentration={stats.concentration} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write the 4-state Storybook file**

```tsx
// src/caliber-ui/compositions/Admin/PoolPanel.stories.tsx
import type { Meta, StoryObj } from "@storybook/react";
import { PoolPanel } from "./PoolPanel";
import { adminPoolStats } from "../../fixtures";
import type { AdminPoolStats } from "../../../types";

const meta: Meta<typeof PoolPanel> = {
  title: "Compositions/Admin/PoolPanel",
  component: PoolPanel,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof PoolPanel>;

const emptyPoolStats: AdminPoolStats = {
  totals: { live: 0, delisted: 0, newLast24h: 0, sourcesEnabled: 0, sourcesTotal: 0, tagCoveragePct: 0 },
  functionMix: [],
  tzBands: [
    { band: "americas", count: 0, share: 0 },
    { band: "emea", count: 0, share: 0 },
    { band: "apac", count: 0, share: 0 },
    { band: "unassigned", count: 0, share: 0 },
  ],
  freshness: [
    { bucket: "24h", count: 0 },
    { bucket: "2-7d", count: 0 },
    { bucket: "8-30d", count: 0 },
    { bucket: "older", count: 0 },
  ],
  concentration: { topCompanies: [], top10Count: 0, restCount: 0 },
};

export const Loading: Story = {
  args: { loading: true },
};

export const Empty: Story = {
  args: { loading: false, stats: emptyPoolStats },
};

export const ErrorWithRetry: Story = {
  args: {
    loading: false,
    error: "Couldn't load pool stats. Check your connection and try again.",
    onRetry: () => console.log("retry"),
  },
};

export const Populated: Story = {
  args: { loading: false, stats: adminPoolStats },
};
```

- [ ] **Step 3: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/caliber-ui/compositions/Admin/PoolPanel.tsx src/caliber-ui/compositions/Admin/PoolPanel.stories.tsx
git commit -m "$(cat <<'EOF'
feat(admin-pool): PoolPanel composition with the 4 spec states

Claude-Session: https://claude.ai/code/session_01PfEetLvdfmxSVcT54vtfhf
EOF
)"
```

---

## Task 7: `/admin/pool` page + admin tab row + nav gating (spec §2)

**Files:**
- Create: `src/app/(app)/admin/pool/page.tsx` (+ `page.test.tsx`)
- Modify: `src/features/admin/client.ts` (add `getPoolStats`)
- Modify: `src/caliber-ui/compositions/Shell/AppSidebar.tsx:29-33, 61` (add the "Pool" nav item)
- Modify: `src/app/AppShell.tsx:29-38, 41-51` (route↔nav-id wiring)

**Read first:**
- `src/app/(app)/admin/crawl/page.tsx` (full file, already read) — the page shape this mirrors exactly: `"use client"`, `getCrawlStatus`/`ApiError` 403→`forbidden`, header, `maxWidth: var(--content-max)` wrapper. Swapped 1:1: `CrawlPanel`→`PoolPanel`, `getCrawlStatus`→`getPoolStats`, header label "Crawl"→"Pool". Because `PoolPanel` (unlike `CrawlPanel`) owns its own loading/empty-state rendering, this page is SIMPLER than `admin/crawl/page.tsx` — no `loaded &&` gate, `loading` state starts `true` and is passed straight through.
- `src/app/(app)/admin/page.test.tsx` (full file, already read) — the `@vitest-environment jsdom` + `vi.hoisted`-mocked `features/admin/client` + `testing-library/react` pattern for forbidden/error/retry.
- `src/features/admin/client.ts` (full file, already read) — `getCrawlStatus()`'s one-line `requestJson(path, undefined, Schema)` shape; `getPoolStats()` mirrors it, added after `getCrawlStatus`.
- `src/caliber-ui/compositions/Shell/AppSidebar.tsx:29-33` — `ADMIN_SIDEBAR_ITEMS` (`admin-users`, `admin-crawl`); line 61's `enabled` Set. Adding `{ id: "admin-pool", label: "Pool", icon: "bar-chart-3" }` (icon confirmed present in `src/caliber-ui/components/Icon.tsx`'s `ICONS` map) + `"admin-pool"` to the Set.
- `src/app/AppShell.tsx:29-38` (`routeFor`) and `:41-51` (`activeIdFor`) — adding `"admin-pool": "/admin/pool"` to `routeFor`, and `if (pathname.startsWith("/admin/pool")) return "admin-pool";` to `activeIdFor`, inserted BEFORE the generic `if (pathname.startsWith("/admin")) return "admin-users";` catch-all — same ordering `admin-crawl`'s check already uses, since `/admin/pool` also starts with `/admin`.

**Interfaces:**
- Consumes: `PoolPanel` (Task 6); `AdminPoolStats` (Task 2); `GET /api/admin/pool` (Task 4, via `getPoolStats()`); `requestJson`, `ApiError` (`@/features/http`, existing).
- Produces: routed page at `/admin/pool`; `getPoolStats(): Promise<AdminPoolStats>` exported from `@/features/admin/client` (no other task consumes it further).

- [ ] **Step 1: Add the typed client function**

In `src/features/admin/client.ts`, add `AdminPoolStats` to the `import { ... } from "@/types"` line, then append after `getCrawlStatus`:

```ts
export async function getPoolStats(): Promise<AdminPoolStats> {
  return requestJson("/api/admin/pool", undefined, AdminPoolStats);
}
```

- [ ] **Step 2: Write the failing page test**

```tsx
// src/app/(app)/admin/pool/page.test.tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { ApiError } from "@/features/http";
import type { AdminPoolStats } from "@/types";

afterEach(cleanup);

const { getPoolStats } = vi.hoisted(() => ({ getPoolStats: vi.fn() }));
vi.mock("@/features/admin/client", () => ({ getPoolStats }));

import AdminPoolPage from "./page";

const stats: AdminPoolStats = {
  totals: { live: 10, delisted: 1, newLast24h: 2, sourcesEnabled: 3, sourcesTotal: 4, tagCoveragePct: 10 },
  functionMix: [{ bucket: "engineering", count: 10, share: 100, source: "keyword" }],
  tzBands: [
    { band: "americas", count: 10, share: 100 },
    { band: "emea", count: 0, share: 0 },
    { band: "apac", count: 0, share: 0 },
    { band: "unassigned", count: 0, share: 0 },
  ],
  freshness: [
    { bucket: "24h", count: 2 },
    { bucket: "2-7d", count: 3 },
    { bucket: "8-30d", count: 3 },
    { bucket: "older", count: 2 },
  ],
  concentration: { topCompanies: [{ company: "Acme", count: 10 }], top10Count: 10, restCount: 0 },
};

beforeEach(() => {
  getPoolStats.mockReset();
});

describe("AdminPoolPage load", () => {
  it("renders the tile row once the client resolves", async () => {
    getPoolStats.mockResolvedValue(stats);
    render(<AdminPoolPage />);

    expect(await screen.findByText("Live postings")).toBeInTheDocument();
  });
});

describe("AdminPoolPage forbidden", () => {
  it("shows a no-access state on a 403, not the generic error banner", async () => {
    getPoolStats.mockRejectedValue(new ApiError(403, "FORBIDDEN", "Admins only."));
    render(<AdminPoolPage />);

    expect(await screen.findByText(/do not have access/i)).toBeInTheDocument();
    expect(screen.queryByText("Admins only.")).not.toBeInTheDocument();
  });
});

describe("AdminPoolPage generic error", () => {
  it("shows the error message and a Retry that reloads", async () => {
    getPoolStats.mockRejectedValue(new Error("Couldn't load pool stats."));
    render(<AdminPoolPage />);

    expect(await screen.findByText("Couldn't load pool stats.")).toBeInTheDocument();

    getPoolStats.mockResolvedValue(stats);
    screen.getByRole("button", { name: /retry/i }).click();

    await waitFor(() => expect(getPoolStats).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Live postings")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run "src/app/(app)/admin/pool/page.test.tsx"`
Expected: FAIL — `Cannot find module './page'`.

- [ ] **Step 4: Write the page**

```tsx
// src/app/(app)/admin/pool/page.tsx
"use client";
// Pool dashboard: admin-only stats view over the global postings pool (spec
// 2026-07-21-admin-pool-tab-design.md). Same admin guard/degrade pattern as
// admin/crawl/page.tsx: getPoolStats() 403s the same way getCrawlStatus()
// does, so a non-admin hitting this URL directly lands on the "no access"
// state, not the generic error banner. PoolPanel owns its own loading/
// empty rendering (unlike CrawlPanel), so this page is a thin fetch+forbidden
// wrapper.
import * as React from "react";
import { PoolPanel } from "@/caliber-ui/compositions/Admin/PoolPanel";
import { Icon } from "@/caliber-ui/components/Icon";
import { getPoolStats } from "@/features/admin/client";
import { ApiError } from "@/features/http";
import type { AdminPoolStats } from "@/types";

export default function AdminPoolPage() {
  const [stats, setStats] = React.useState<AdminPoolStats | undefined>();
  const [loading, setLoading] = React.useState(true);
  const [forbidden, setForbidden] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>();

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(undefined);
    setForbidden(false);
    try {
      const data = await getPoolStats();
      setStats(data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setForbidden(true);
      } else {
        setError(err instanceof Error ? err.message : "Couldn't load pool stats.");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-app)" }}>
      <header style={{ padding: "16px 24px", background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <span style={{ font: "700 18px/1 var(--font-display)", color: "var(--text-strong)", letterSpacing: "-0.01em" }}>
          Caliber
        </span>
        <span style={{ font: "var(--type-body)", color: "var(--text-muted)", marginLeft: 14 }}>Pool</span>
      </header>
      <div style={{ maxWidth: "var(--content-max)", margin: "0 auto", padding: 24 }}>
        {forbidden ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "48px 20px", textAlign: "center" }}>
            <Icon name="shield" size={20} />
            <span style={{ font: "var(--type-body)", color: "var(--text-muted)" }}>You do not have access to this page.</span>
          </div>
        ) : (
          <PoolPanel stats={stats} loading={loading} error={error} onRetry={() => void load()} />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run "src/app/(app)/admin/pool/page.test.tsx"`
Expected: PASS (3 tests).

- [ ] **Step 6: Wire the admin nav**

In `src/caliber-ui/compositions/Shell/AppSidebar.tsx`, change:

```ts
export const ADMIN_SIDEBAR_ITEMS: NavItem[] = [
  { section: "Admin" },
  { id: "admin-users", label: "Users", icon: "users" },
  { id: "admin-crawl", label: "Crawl", icon: "activity" },
];
```

to:

```ts
export const ADMIN_SIDEBAR_ITEMS: NavItem[] = [
  { section: "Admin" },
  { id: "admin-users", label: "Users", icon: "users" },
  { id: "admin-crawl", label: "Crawl", icon: "activity" },
  { id: "admin-pool", label: "Pool", icon: "bar-chart-3" },
];
```

and change:

```ts
const enabled = isAdmin ? new Set([...DEFAULT_ENABLED, "admin-users", "admin-crawl"]) : DEFAULT_ENABLED;
```

to:

```ts
const enabled = isAdmin ? new Set([...DEFAULT_ENABLED, "admin-users", "admin-crawl", "admin-pool"]) : DEFAULT_ENABLED;
```

In `src/app/AppShell.tsx`, change:

```ts
const routeFor: Record<string, string> = {
  matches: "/feed",
  applied: "/tracker",
  scans: "/scans",
  resume: "/resume",
  sources: "/sources",
  profile: "/profile",
  "admin-users": "/admin",
  "admin-crawl": "/admin/crawl",
};
```

to:

```ts
const routeFor: Record<string, string> = {
  matches: "/feed",
  applied: "/tracker",
  scans: "/scans",
  resume: "/resume",
  sources: "/sources",
  profile: "/profile",
  "admin-users": "/admin",
  "admin-crawl": "/admin/crawl",
  "admin-pool": "/admin/pool",
};
```

and change:

```ts
function activeIdFor(pathname: string): string | undefined {
  if (pathname === "/feed" || pathname.startsWith("/jobs")) return "matches";
  if (pathname.startsWith("/tracker")) return "applied";
  if (pathname.startsWith("/scans")) return "scans";
  if (pathname.startsWith("/resume")) return "resume";
  if (pathname.startsWith("/sources")) return "sources";
  if (pathname.startsWith("/profile")) return "profile";
  if (pathname.startsWith("/admin/crawl")) return "admin-crawl";
  if (pathname.startsWith("/admin")) return "admin-users";
  return undefined;
}
```

to:

```ts
function activeIdFor(pathname: string): string | undefined {
  if (pathname === "/feed" || pathname.startsWith("/jobs")) return "matches";
  if (pathname.startsWith("/tracker")) return "applied";
  if (pathname.startsWith("/scans")) return "scans";
  if (pathname.startsWith("/resume")) return "resume";
  if (pathname.startsWith("/sources")) return "sources";
  if (pathname.startsWith("/profile")) return "profile";
  if (pathname.startsWith("/admin/crawl")) return "admin-crawl";
  if (pathname.startsWith("/admin/pool")) return "admin-pool";
  if (pathname.startsWith("/admin")) return "admin-users";
  return undefined;
}
```

- [ ] **Step 7: Run the full nav-adjacent test suite to confirm no regressions**

Run: `npx vitest run src/caliber-ui/compositions/Shell "src/app/(app)/admin"`
Expected: PASS (existing `AppSidebar`/`AdminPage`/`AdminCrawlPage` tests unaffected; new `AdminPoolPage` tests pass).

- [ ] **Step 8: Commit**

```bash
git add "src/app/(app)/admin/pool/page.tsx" "src/app/(app)/admin/pool/page.test.tsx" src/features/admin/client.ts src/caliber-ui/compositions/Shell/AppSidebar.tsx src/app/AppShell.tsx
git commit -m "$(cat <<'EOF'
feat(admin-pool): /admin/pool page + admin tab row + nav gating

Claude-Session: https://claude.ai/code/session_01PfEetLvdfmxSVcT54vtfhf
EOF
)"
```

---

## Task 8: final gate + docs (spec §7 wrap-up)

**Files:**
- Modify: `docs/architecture/component-inventory.md` (append rows for the 3 new compositions, under "1a. Auth, onboarding & admin")

**Read first:** `docs/architecture/component-inventory.md:63-68` — the existing `AppSidebar`/`AdminUsersTable`/`AdminPage` row format (`| **Name** | Purpose | Key props (TS) | Composes | States/variants to story |`) and the prose line below the table describing `ADMIN_SIDEBAR_ITEMS` gating. This task's edit mirrors that row format and extends that prose line.

**Interfaces:**
- Consumes: nothing new (documents Tasks 1–7's finished shapes).
- Produces: nothing consumed by other tasks — this is the plan's terminal task.

- [ ] **Step 1: Add component-inventory rows**

In `docs/architecture/component-inventory.md`, immediately after the existing `AdminPage` row (line 66), insert:

```
| **PoolFunctionCards** | Admin Pool tab — 12 function-bucket stat cards (spec 2026-07-21) | `{ mix: AdminPoolStats["functionMix"] }` | Card | populated (12 buckets, largest numeral in `--accent-ink`) |
| **PoolStrips** | Admin Pool tab — TZ band / freshness / company-concentration 100%-stacked strips | `{ tzBands; freshness; concentration }` | Chip (legends), FitBar-geometry bars | populated |
| **PoolPanel** (`(app)/admin/pool`) | Admin Pool tab body — tile row + PoolFunctionCards + PoolStrips, calls `GET /api/admin/pool` | `{ stats?: AdminPoolStats; loading: boolean; error?: string; onRetry?(): void }` | PoolFunctionCards, PoolStrips, Button, Icon, Card | loading skeleton / empty (pool empty) / error+retry / populated |
```

And update the prose line (originally line 68) from:

```
`AppShell` (`src/app/AppShell.tsx`) mounts `AppSidebar` around every `(app)` page, drives active-tab from the router pathname, and resets client-side stores (e.g. the url-check dock) when the signed-in user id changes between sessions. The **Admin** sidebar section (`ADMIN_SIDEBAR_ITEMS`, id `admin-users` → `/admin`) is appended only when `user.role === 'admin'` — a non-admin never sees the nav entry, and the API still enforces `requireAdmin()` independently (defense in depth, not a second authorization system).
```

to:

```
`AppShell` (`src/app/AppShell.tsx`) mounts `AppSidebar` around every `(app)` page, drives active-tab from the router pathname, and resets client-side stores (e.g. the url-check dock) when the signed-in user id changes between sessions. The **Admin** sidebar section (`ADMIN_SIDEBAR_ITEMS`: `admin-users` → `/admin`, `admin-crawl` → `/admin/crawl`, `admin-pool` → `/admin/pool`) is appended only when `user.role === 'admin'` — a non-admin never sees the nav entries, and every admin API still enforces `requireAdmin()` independently (defense in depth, not a second authorization system).
```

- [ ] **Step 2: Run the full gate**

Run: `npm run check`
Expected: PASS — `typecheck && vitest run && contract:check && build` all green. This is the exact gate the repo's commit hook runs; if `contract:check` fails, re-run `npm run contract` and re-commit `contract/openapi.json` (should already be committed from Task 4 — this just confirms it's still in sync after Tasks 5-8's unrelated changes).

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/component-inventory.md
git commit -m "$(cat <<'EOF'
docs(component-inventory): document PoolFunctionCards/PoolStrips/PoolPanel

Claude-Session: https://claude.ai/code/session_01PfEetLvdfmxSVcT54vtfhf
EOF
)"
```

---

## Self-review (completed during drafting)

**Spec coverage:**
- §1.1 static v1 sparkline/filter-chip reservation → Task 5 (`PoolFunctionCards`' reserved-empty slot comment). No filter-chip row was built — correctly out of scope: spec §1.1 reserves the slot conceptually but §3's UI composition list never places a filter-chip row on this tab, so there is nothing to build.
- §1.2 hybrid function source → Task 1 (`bucketFromTitle`) + Task 3 (`getPoolStats`'s per-row `functionTag ?? bucketFromTitle(title)`).
- §1.3 design system / red accent once → Task 5 (`PoolFunctionCards` largest-bucket `--accent-ink`).
- §2 route & access → Task 4 (`requireAdmin()`), Task 7 (page + nav gating, defense-in-depth note).
- §3 UI composition (tile row, PoolFunctionCards, PoolStrips, states) → Tasks 5, 6.
- §4 contract → Task 2.
- §5 server (one repo aggregate, zero LLM) → Task 3, Task 4.
- §6 keyword bucket helper (order, TS-only, pinned collision) → Task 1.
- §7 testing (unit/repo/contract/403/Storybook) → Tasks 1, 2, 3, 4, 6.
- §8 reference snapshot → used as fixture inspiration only (Task 5), explicitly not copied verbatim per the spec's own caveat.
- §9 out of scope → confirmed nothing built for history/sparkline-series/cross-filter/user-facing view/batch LLM classification.
- §10 follow-ups → no action required now; `PoolStrips`' clean prop shape (`tzBands`/`freshness`/`concentration`, no admin-only coupling) leaves the door open for later reuse, matching §10's "possible user-facing market overview reusing PoolStrips" note.

**Placeholder scan:** no `TBD`/`TODO`/"add appropriate handling" strings anywhere above; every step has literal, complete code; every "mirror X" reference names the exact file and line range read during planning, not "similar to Task N".

**Type consistency:** `AdminPoolStats` (Task 2) shape is used identically in Task 3's repo return, Task 4's route/tests, Task 5/6's component props and fixtures, and Task 7's page/tests — `bucket`, `share`, `source`, `band`, `tagCoveragePct` etc. spelled the same way throughout. `bucketFromTitle`/`FUNCTION_BUCKET_IDS` (Task 1) names match their Task 3 import exactly. `poolStatsRepo.getPoolStats(nowMs)` signature matches its Task 4 call site (`poolStatsRepo.getPoolStats(Date.now())`) and its Task 3 test call (`repo.getPoolStats(NOW)`).

**Grounding gap:** none — every task's file layout, error-handling shape, test harness, and UI idiom was read from a real sibling file in this repo before being written into the plan (cited per-task above). The one deliberate DEVIATION from the closest literal precedent (`CrawlPanel`, which has no Storybook file and lets the page own loading/error) is explicitly justified in Task 6: spec §7 requires 4 storied states, and `JobFeed` is the actual precedent in this codebase for a composition that owns those states itself and is storied for exactly this 4-state list.
