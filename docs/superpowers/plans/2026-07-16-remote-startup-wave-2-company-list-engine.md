# Wave 2: Company-List Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grow `sources` from 12 hand-seeded companies to a validated, self-healing list of ~1,500–4,000 remote-startup ATS boards (ramped to ~200–300 enabled), using MIT-licensed public datasets and the three ATS connectors that already exist.
**Architecture:** A new `src/server/search/companyList/` module tree — pure CSV/domain/validation functions, a bulk-seed orchestrator, and a re-detection module — wired into one weekly cron entry (`revalidateCron.ts`, following the repo's existing host-cron pattern) and one admin read (`GET /api/admin/sources`). No new DB columns: health fields (`lastValidatedAt`, `jobCount`, `consecutiveFailures`, `status`) live inside the existing `sources.config` JSON column, validated by a new `SourceConfig` Zod schema.
**Tech Stack:** TypeScript, Zod, Drizzle/libsql, `p-limit` (already a dependency), Vitest. No new npm dependencies (no CSV library — see Task 2).

## Global Constraints
- Layering: UI → `features/*` → `server/*`. Only `server/*` touches DB or the network in this wave (no LLM calls — this wave has zero LLM cost).
- Fail loud: `SourceConfig.parse(source.config)` at every read boundary; no silent `0`/`""`/`unknown` defaults.
- `SourceConfig` is an internal/engine schema, NOT a wire contract entity — do not register it in `src/contract/registry.ts`; `npm run contract:check` must stay unaffected.
- This wave needs **no new migration** — health fields live in the existing `config` JSON column (spec §4.3: "promote to columns when the admin UI must query them" — not yet). If a future task ever adds a column, migrations are generated via `npm run db:generate` — never hand-authored SQL.
- HTTP 200 is non-negotiable before any slug is seeded (the Aspire 404 is why) — `toSourceRow` throws if `validation.ok` is false.
- Politeness: ≤2–4 concurrent requests per vendor host, via `p-limit` (already used in `run.ts`/`worker.ts` — do not add a second concurrency library).
- Domain-join is on normalized domain, **never** company name.
- libsql `file:` driver forbids concurrent `db.transaction` — bulk inserts run in small sequential batches (200 rows), never one giant statement, never concurrent transactions.
- The commit hook runs `tsc` from the session's cwd (the main checkout) — keep the main checkout's types green.
- Tests: `npx vitest run <path>`. Full suite is ~1300+ green on main — keep it green.
- Conventional-commit messages. No `Co-Authored-By` trailer, ever.

---

## Repo reconnaissance (read before building — this is what actually exists)

- **No `scripts/` directory, no `.sh` files.** The repo's one-off-script convention is a plain `.ts` file under `src/server/**` with a `if (process.argv[1] === fileURLToPath(import.meta.url))` module-main guard (see `src/server/persistence/seed.ts`, `src/server/score/recompute-eligibility.ts`), invoked via a `package.json` script running `tsx` (e.g. `"eligibility:recompute": "tsx src/server/score/recompute-eligibility.ts"`). This plan's cron entry (`revalidateCron.ts`) follows this exact pattern — no new convention invented.
- **No in-app scheduler/cron library** (no `node-cron`, no `bottleneck`, nothing in `package.json`). The repo's real cron pattern lives at the **host level**, documented in `DEPLOY.md` (§"Backup") and `.claude/skills/box/SKILL.md`: a plain `/etc/cron.daily/caliber-backup` entry that runs `docker compose exec -T app npx tsx ...` (or `docker compose run --rm app npx tsx <path>` for one-offs like `migrate-uploads.ts`). Task 7 adds a parallel `/etc/cron.weekly/caliber-sources-revalidate` entry, documented in `DEPLOY.md` next to the existing backup section — the minimal pattern consistent with the repo, not a new scheduler.
- **Admin surface exists**: `src/app/(app)/admin/page.tsx` (client component, role-gated via the API's `requireAdmin()`) + `src/app/api/admin/users/route.ts` (the `GET /api/admin/users` precedent: `requireAdmin()` → 401/403 mapping → `.parse()` the response). Task 8 adds a sibling `GET /api/admin/sources` route and a small stat line on the same admin page — no new page, no new component.
- **No CSV parsing library** in `package.json` (no `papaparse`, `csv-parse`, `fast-csv`). Task 2 writes a small hand-rolled RFC4180-ish line parser (quoted fields only — the one irregular bit for a 3-column `name,slug,url` schema) rather than adding a dependency for one column shape.
- `p-limit@^3.1.0` **is** already a dependency, used in `run.ts`/`worker.ts` — reused here, not reinvented.

## Two open gaps this plan surfaces rather than papers over (read before Task 3 / Task 5 / Task 7)

1. **`companyDomain` sourcing is unresolved.** The spec/spine's domain-join description ("join jobhive `url`-domain against yc-oss/remoteintech `website`") does not actually work as literally stated: jobhive's stated 3-column schema (`name,slug,url`) has `url` = the ATS-hosted board URL (`https://jobs.lever.co/ramp`), whose domain (`lever.co`) is identical across thousands of companies on the same ATS — it cannot join against a per-company `website` domain. Task 3 builds the join **primitive** correctly and generically (it operates on whatever `companyDomain` string the caller supplies per row); it does NOT resolve where that string comes from for the real ~9,935 jobhive rows. This is called out as an explicit manual/design pre-task, not invented around.
2. **`careersUrl` is not a named `SourceConfig` field** (per spine §3.1's verbatim schema), yet re-detection (spine §3.6) needs a careers page to fetch. `SourceConfig` is `.passthrough()`, so a `careersUrl` string (e.g. sourced from remoteintech's `careers_url` field at seed time) rides through as an unvalidated extra key — Task 7 reads it defensively (`typeof config.careersUrl === "string"`) and falls back to guessing `https://{companyDomain}` when absent. This does not contradict the named spine schema; it uses the passthrough escape hatch the spine itself specifies for "other keys."

Both are flagged again in the Self-review section and in the final handoff summary.

---

## File Structure

**Create:**
- `src/types/sourceConfig.test.ts` — TDD fixtures for the new `SourceConfig` schema.
- `src/server/search/companyList/csv.ts` — jobhive CSV row parser + the greenhouse host-trap slug extractor.
- `src/server/search/companyList/csv.test.ts`
- `src/server/search/companyList/domainJoin.ts` — domain normalization + the niche-filter join primitive.
- `src/server/search/companyList/domainJoin.test.ts`
- `src/server/search/companyList/validate.ts` — per-connector HTTP-200 slug validation (greenhouse/lever/ashby).
- `src/server/search/companyList/validate.test.ts`
- `src/server/search/companyList/bulkSeed.ts` — validate-and-rank orchestration, `toSourceRow`, ramp-to-N-enabled, batched bulk insert, the 3 SEA seeds.
- `src/server/search/companyList/bulkSeed.test.ts`
- `src/server/search/companyList/redetect.ts` — ATS-signature re-detection from a careers page's HTML.
- `src/server/search/companyList/redetect.test.ts`
- `src/server/search/companyList/revalidate.ts` — the weekly freshness pass: revalidate every enabled ATS source, increment/reset `consecutiveFailures`, trigger re-detection at the dead threshold, rewrite `config` in place.
- `src/server/search/companyList/revalidate.test.ts`
- `src/server/search/companyList/revalidateCron.ts` — the `tsx` cron entry point (module-main guard, mirrors `seed.ts`/`recompute-eligibility.ts`).
- `src/app/api/admin/sources/route.ts` — `GET` dead/enabled/total source counts, `requireAdmin()`-gated.
- `src/app/api/admin/sources/route.test.ts`

**Modify:**
- `src/types/index.ts` — add `SourceConfig` (fail-loud parse of `sources.config`) and `AdminSourcesStats` (the admin route's response shape).
- `src/server/persistence/repos/sources.ts` — add `updateConfig(id, config)`, mirroring the existing `setEnabled` method.
- `package.json` — add `"sources:revalidate": "tsx --env-file-if-exists=.env.local src/server/search/companyList/revalidateCron.ts"`.
- `DEPLOY.md` — document the weekly host-cron entry, next to the existing nightly-backup cron section.
- `src/features/admin/client.ts` — add `getAdminSourcesStats()`.
- `src/app/(app)/admin/page.tsx` — render the dead/enabled/total stat line.

---

### Task 1: `SourceConfig` Zod schema
**Files:** Create `src/types/sourceConfig.test.ts` · Modify `src/types/index.ts`
**Interfaces:**
- Produces: `export const SourceConfig: z.ZodObject<...>` (`.passthrough()`), `export type SourceConfig = z.infer<typeof SourceConfig>`.
- Consumes: nothing (pure schema).

- [ ] **Step 1: Write the failing test**
```ts
// src/types/sourceConfig.test.ts
import { describe, expect, it } from "vitest";
import { SourceConfig } from "./index";

describe("SourceConfig", () => {
  it("parses a minimal ats config with no health fields yet", () => {
    const parsed = SourceConfig.parse({ connector: "greenhouse", slug: "vercel", geo: { scope: "anywhere" } });
    expect(parsed.connector).toBe("greenhouse");
    expect(parsed.status).toBeUndefined();
  });

  it("parses the full health-field set the engine writes", () => {
    const parsed = SourceConfig.parse({
      connector: "lever",
      slug: "ramp",
      geo: { scope: "restricted", regions: ["APAC"] },
      provenance: ["jobhive", "yc-oss"],
      companyDomain: "ramp.com",
      lastValidatedAt: "2026-07-16T02:00:00.000Z",
      jobCount: 87,
      consecutiveFailures: 0,
      status: "active",
    });
    expect(parsed.jobCount).toBe(87);
    expect(parsed.status).toBe("active");
  });

  it("is permissive of board-only keys via passthrough (api/siteKey/query/pageSize/maxPages/country)", () => {
    const parsed = SourceConfig.parse({
      connector: "jobstreet",
      api: "https://my.jobstreet.com/api/jobsearch/v5/search",
      siteKey: "MY-Main",
      query: "software engineer",
      pageSize: 30,
      maxPages: 3,
      country: "MY",
    });
    expect(parsed.connector).toBe("jobstreet");
    expect((parsed as Record<string, unknown>).siteKey).toBe("MY-Main");
  });

  it("fails loud when connector is missing", () => {
    expect(() => SourceConfig.parse({ slug: "vercel" })).toThrow();
  });

  it("fails loud on an invalid status value", () => {
    expect(() => SourceConfig.parse({ connector: "greenhouse", status: "zombie" })).toThrow();
  });
});
```
- [ ] **Step 2: Run test to verify it fails** — `npx vitest run src/types/sourceConfig.test.ts -t "SourceConfig"` — Expected: FAIL (`SourceConfig` is not exported from `./index`).
- [ ] **Step 3: Write minimal implementation** — append to `src/types/index.ts`, directly after the existing `Source` schema block (both describe the same `sources` row):
```ts
// Engine-side schema for `sources.config` (spec 2026-07-16-remote-startup-
// niche-source-expansion-design.md §4.3, design-spine §3.1). NOT a wire
// contract entity — never registered in src/contract/registry.ts. `.passthrough()`
// because board configs (jobstreet) carry unrelated keys (api/siteKey/query/…)
// and a re-detected row may carry a `careersUrl` passthrough key sourced from
// remoteintech's careers_url (see companyList/revalidate.ts) that isn't a
// named field here.
export const SourceConfig = z.object({
  connector: z.string(),
  slug: z.string().optional(),
  geo: z.object({ scope: z.string(), regions: z.array(z.string()).optional() }).optional(),
  provenance: z.array(z.string()).optional(),
  companyDomain: z.string().optional(),
  lastValidatedAt: z.string().datetime().optional(),
  jobCount: z.number().int().nonnegative().optional(),
  consecutiveFailures: z.number().int().nonnegative().optional(),
  status: z.enum(["active", "dead"]).optional(),
}).passthrough();
export type SourceConfig = z.infer<typeof SourceConfig>;
```
- [ ] **Step 4: Run test to verify it passes** — `npx vitest run src/types/sourceConfig.test.ts -t "SourceConfig"` — Expected: PASS (5 tests).
- [ ] **Step 5: Commit**
```
git add src/types/index.ts src/types/sourceConfig.test.ts
git commit -m "feat(types): add SourceConfig schema for fail-loud sources.config parsing"
```

---

### Task 2: jobhive CSV parse + the greenhouse host trap
**Files:** Create `src/server/search/companyList/csv.ts`, `src/server/search/companyList/csv.test.ts`

**Manual pre-task (NOT part of this task's steps — blocks running this against real data, does not block the task itself):** the real jobhive dataset (`kalil0321/ats-scrapers`, MIT-licensed per spec grounding) has no pinned download URL or commit hash recorded anywhere in the spec/spine. **UNKNOWN — resolve before vendoring:** browse `github.com/kalil0321/ats-scrapers`, confirm the 3 per-ATS CSVs still exist and are still MIT-licensed, and commit them verbatim as `data/jobhive/greenhouse.csv`, `data/jobhive/ashby.csv`, `data/jobhive/lever.csv`. This task's parser is tested against small inline fixtures and does not depend on those files existing yet.

**Interfaces:**
- Produces: `type AtsConnector = "greenhouse" | "lever" | "ashby"`, `interface JobhiveCompany { name: string; slug: string; ats: AtsConnector; url: string }`, `parseJobhiveCsv(csvText: string, ats: AtsConnector): JobhiveCompany[]`, `extractSlugFromUrl(url: string, ats: AtsConnector): string | null`.
- Consumes: nothing (pure).

- [ ] **Step 1: Write the failing test**
```ts
// src/server/search/companyList/csv.test.ts
import { describe, expect, it } from "vitest";
import { extractSlugFromUrl, parseJobhiveCsv } from "./csv";

describe("parseJobhiveCsv", () => {
  it("parses name,slug,url rows for greenhouse (legacy boards.greenhouse.io host)", () => {
    const csv = "name,slug,url\nGitLab,gitlab,https://boards.greenhouse.io/gitlab";
    expect(parseJobhiveCsv(csv, "greenhouse")).toEqual([
      { name: "GitLab", slug: "gitlab", ats: "greenhouse", url: "https://boards.greenhouse.io/gitlab" },
    ]);
  });

  it("parses the new job-boards.greenhouse.io host — the host trap (4,848/4,966 rows use it)", () => {
    const csv = "name,slug,url\nVercel,vercel,https://job-boards.greenhouse.io/vercel";
    expect(parseJobhiveCsv(csv, "greenhouse")).toEqual([
      { name: "Vercel", slug: "vercel", ats: "greenhouse", url: "https://job-boards.greenhouse.io/vercel" },
    ]);
  });

  it("parses lever and ashby rows", () => {
    expect(parseJobhiveCsv("name,slug,url\nRamp,ramp,https://jobs.lever.co/ramp", "lever")).toEqual([
      { name: "Ramp", slug: "ramp", ats: "lever", url: "https://jobs.lever.co/ramp" },
    ]);
    expect(parseJobhiveCsv("name,slug,url\nZapier,zapier,https://jobs.ashbyhq.com/zapier", "ashby")).toEqual([
      { name: "Zapier", slug: "zapier", ats: "ashby", url: "https://jobs.ashbyhq.com/zapier" },
    ]);
  });

  it("handles a quoted name field containing a comma", () => {
    const csv = 'name,slug,url\n"Ramp, Inc.",ramp,https://jobs.lever.co/ramp';
    expect(parseJobhiveCsv(csv, "lever")).toEqual([
      { name: "Ramp, Inc.", slug: "ramp", ats: "lever", url: "https://jobs.lever.co/ramp" },
    ]);
  });

  it("skips a row whose url doesn't match the connector's host pattern, never fabricating a slug", () => {
    const csv = "name,slug,url\nBroken,broken,https://example.com/careers";
    expect(parseJobhiveCsv(csv, "greenhouse")).toEqual([]);
  });

  it("throws when the header is missing name or url columns", () => {
    expect(() => parseJobhiveCsv("name,slug\nGitLab,gitlab", "greenhouse")).toThrow(/missing a required/);
  });
});

describe("extractSlugFromUrl", () => {
  it("accepts both greenhouse hosts", () => {
    expect(extractSlugFromUrl("https://boards.greenhouse.io/stripe", "greenhouse")).toBe("stripe");
    expect(extractSlugFromUrl("https://job-boards.greenhouse.io/stripe", "greenhouse")).toBe("stripe");
  });

  it("returns null for a non-matching host (e.g. the API host, never a board host)", () => {
    expect(extractSlugFromUrl("https://boards-api.greenhouse.io/v1/boards/stripe/jobs", "greenhouse")).toBeNull();
  });
});
```
- [ ] **Step 2: Run test to verify it fails** — `npx vitest run src/server/search/companyList/csv.test.ts -t "parseJobhiveCsv"` — Expected: FAIL (module `./csv` doesn't exist).
- [ ] **Step 3: Write minimal implementation**
```ts
// src/server/search/companyList/csv.ts
// jobhive ingest (spec §4.3 step 1, spine §3.2): parses the vendored
// kalil0321/ats-scrapers CSVs (MIT), one file per ATS, schema `name,slug,url`.
// No CSV library in package.json — RFC4180 quoted-field handling is the only
// irregular bit (company names may contain commas), so a small hand-rolled
// parser beats a dependency for one 3-column shape.
export type AtsConnector = "greenhouse" | "lever" | "ashby";

export interface JobhiveCompany {
  name: string;
  slug: string;
  ats: AtsConnector;
  url: string;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

// The host trap (spec §4.3 step 3, spine §3.2): a jobhive greenhouse row's
// `url` comes from EITHER `boards.greenhouse.io/{slug}` or the newer
// `job-boards.greenhouse.io/{slug}` (4,848/4,966 rows use the new host). The
// API host `boards-api.greenhouse.io` is unrelated to this trap and never
// appears in the vendored CSV's `url` column.
const SLUG_PATTERNS: Record<AtsConnector, RegExp> = {
  greenhouse: /^https?:\/\/(?:boards|job-boards)\.greenhouse\.io\/([\w-]+)/,
  lever: /^https?:\/\/jobs\.lever\.co\/([\w-]+)/,
  ashby: /^https?:\/\/jobs\.ashbyhq\.com\/([\w.-]+)/,
};

export function extractSlugFromUrl(url: string, ats: AtsConnector): string | null {
  const match = SLUG_PATTERNS[ats].exec(url.trim());
  return match ? match[1] : null;
}

export function parseJobhiveCsv(csvText: string, ats: AtsConnector): JobhiveCompany[] {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const [header, ...rows] = lines;
  const cols = parseCsvLine(header).map((c) => c.trim().toLowerCase());
  const nameIdx = cols.indexOf("name");
  const urlIdx = cols.indexOf("url");
  if (nameIdx === -1 || urlIdx === -1) {
    throw new Error(`jobhive CSV for "${ats}" is missing a required "name" or "url" column (got: ${cols.join(",")})`);
  }

  const out: JobhiveCompany[] = [];
  for (const row of rows) {
    const fields = parseCsvLine(row);
    const name = fields[nameIdx]?.trim();
    const url = fields[urlIdx]?.trim();
    if (!name || !url) continue;
    const slug = extractSlugFromUrl(url, ats);
    if (!slug) continue; // unparseable url — skip, never fabricate a slug
    out.push({ name, slug, ats, url });
  }
  return out;
}
```
- [ ] **Step 4: Run test to verify it passes** — `npx vitest run src/server/search/companyList/csv.test.ts -t "parseJobhiveCsv"` — Expected: PASS (8 tests).
- [ ] **Step 5: Commit**
```
git add src/server/search/companyList/csv.ts src/server/search/companyList/csv.test.ts
git commit -m "feat(search): parse jobhive CSVs into JobhiveCompany rows with the greenhouse host trap"
```

---

### Task 3: Domain normalize + niche-filter join
**Files:** Create `src/server/search/companyList/domainJoin.ts`, `src/server/search/companyList/domainJoin.test.ts`

**Manual pre-task / open gap (see "Two open gaps" above — not resolved by this task):** the exact download locations for yc-oss (`yc-oss/api`, daily JSON, ships `website`+`isHiring`), remoteintech (`remoteintech/remote-jobs`, ships `website`+`careers_url`), and topstartups.io are **UNKNOWN** — no pinned URL is recorded in the spec/spine beyond the repo/site names. Resolving them and vendoring `data/niche/{yc-oss,remoteintech,topstartups}.json` is a manual pre-task. Separately, and more load-bearing: **where each jobhive row's own `companyDomain` comes from is unresolved** (jobhive's schema has no per-company domain field — see the gap note above). This task builds and tests the join primitive against synthetic fixtures; wiring it against the real ~9,935-row set is blocked on both of the above.

**Interfaces:**
- Produces: `normalizeDomain(input: string): string`, `filterByNicheDomains<T extends { companyDomain: string }>(companies: readonly T[], nicheDomains: ReadonlySet<string> | readonly string[]): T[]`.
- Consumes: nothing (pure).

- [ ] **Step 1: Write the failing test**
```ts
// src/server/search/companyList/domainJoin.test.ts
import { describe, expect, it } from "vitest";
import { filterByNicheDomains, normalizeDomain } from "./domainJoin";

describe("normalizeDomain", () => {
  it("strips scheme, www, path/query/hash, and lowercases", () => {
    expect(normalizeDomain("https://www.Ramp.com/careers?utm=1")).toBe("ramp.com");
    expect(normalizeDomain("http://vercel.com")).toBe("vercel.com");
    expect(normalizeDomain("Vercel.com")).toBe("vercel.com");
    expect(normalizeDomain("https://gitlab.com/#section")).toBe("gitlab.com");
  });
});

describe("filterByNicheDomains", () => {
  it("keeps only companies whose domain matches a niche dataset, joined on domain not name", () => {
    const companies = [
      { name: "Ramp Incorporated", companyDomain: "https://www.ramp.com" }, // name deliberately mismatches the niche's "Ramp"
      { name: "Not In Niche", companyDomain: "https://example.com" },
    ];
    const niche = ["ramp.com", "vercel.com"]; // pre-normalized-or-not — the join normalizes both sides
    expect(filterByNicheDomains(companies, niche)).toEqual([{ name: "Ramp Incorporated", companyDomain: "https://www.ramp.com" }]);
  });

  it("returns empty when nothing matches", () => {
    expect(filterByNicheDomains([{ name: "X", companyDomain: "https://x.io" }], ["ramp.com"])).toEqual([]);
  });

  it("accepts a pre-built Set of niche domains without re-normalizing it", () => {
    const set = new Set(["ramp.com"]);
    expect(filterByNicheDomains([{ name: "Ramp", companyDomain: "ramp.com" }], set)).toHaveLength(1);
  });
});
```
- [ ] **Step 2: Run test to verify it fails** — `npx vitest run src/server/search/companyList/domainJoin.test.ts -t "normalizeDomain"` — Expected: FAIL (module `./domainJoin` doesn't exist).
- [ ] **Step 3: Write minimal implementation**
```ts
// src/server/search/companyList/domainJoin.ts
// Domain-join niche filter (spec §4.3 step 2, spine §3.3): a jobhive company
// survives into the niche set only if its OWN domain matches yc-oss's/
// remoteintech's/topstartups.io's `website` — matched on normalized domain,
// NEVER on company name (names collide/format differently across datasets;
// domains don't).
//
// OPEN GAP — do not resolve silently, see the plan's "Two open gaps" note:
// this module is a correct, generic join primitive over whatever
// `companyDomain` the caller supplies per row. Populating that field for the
// real jobhive rows (whose stated schema has no domain column) is NOT
// resolved here.
export function normalizeDomain(input: string): string {
  let value = input.trim().toLowerCase();
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // strip scheme
  value = value.replace(/^www\./, "");
  value = value.split(/[/?#]/)[0]; // strip path/query/hash
  return value;
}

export function filterByNicheDomains<T extends { companyDomain: string }>(
  companies: readonly T[],
  nicheDomains: ReadonlySet<string> | readonly string[],
): T[] {
  const set = nicheDomains instanceof Set ? nicheDomains : new Set(Array.from(nicheDomains, normalizeDomain));
  return companies.filter((c) => set.has(normalizeDomain(c.companyDomain)));
}
```
- [ ] **Step 4: Run test to verify it passes** — `npx vitest run src/server/search/companyList/domainJoin.test.ts -t "normalizeDomain"` — Expected: PASS (4 tests).
- [ ] **Step 5: Commit**
```
git add src/server/search/companyList/domainJoin.ts src/server/search/companyList/domainJoin.test.ts
git commit -m "feat(search): domain-normalize + niche-filter join primitive for company-list ingest"
```

---

### Task 4: Per-connector slug validation (HTTP 200 required)
**Files:** Create `src/server/search/companyList/validate.ts`, `src/server/search/companyList/validate.test.ts`
**Interfaces:**
- Produces: `interface ValidationResult { ok: boolean; status?: number; jobCount?: number }`, `validateSlug(connector: AtsConnector, slug: string): Promise<ValidationResult>`.
- Consumes: `fetchJson`, `ConnectorHttpError` from `../connectors/_http` (reused, not reinvented).

- [ ] **Step 1: Write the failing test**
```ts
// src/server/search/companyList/validate.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateSlug } from "./validate";

describe("validateSlug", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("greenhouse: HTTP 200 returns ok + jobCount from jobs[]", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ jobs: [{}, {}, {}] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await validateSlug("greenhouse", "vercel")).toEqual({ ok: true, status: 200, jobCount: 3 });
    expect(fetchMock).toHaveBeenCalledWith("https://boards-api.greenhouse.io/v1/boards/vercel/jobs", expect.anything());
  });

  it("lever: HTTP 200 returns ok + jobCount from a bare array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify([{}, {}]), { status: 200 })));
    expect(await validateSlug("lever", "ramp")).toEqual({ ok: true, status: 200, jobCount: 2 });
  });

  it("ashby: HTTP 200 returns ok + jobCount from jobs[]", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ jobs: [{}] }), { status: 200 })));
    expect(await validateSlug("ashby", "bjakcareer")).toEqual({ ok: true, status: 200, jobCount: 1 });
  });

  it("returns ok:false + the status on a 404 (the Aspire case), never throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));
    expect(await validateSlug("greenhouse", "aspire")).toEqual({ ok: false, status: 404 });
  });

  it("returns ok:false with no status on a network/timeout failure, never throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await validateSlug("lever", "flaky")).toEqual({ ok: false });
  });
});
```
- [ ] **Step 2: Run test to verify it fails** — `npx vitest run src/server/search/companyList/validate.test.ts -t "validateSlug"` — Expected: FAIL (module `./validate` doesn't exist).
- [ ] **Step 3: Write minimal implementation**
```ts
// src/server/search/companyList/validate.ts
// Slug validation (spec §4.3 step 3, spine §3.4) — non-negotiable before
// seeding: the Aspire 404 proves listing-page slugs lie. Hits the SAME base
// endpoint each connector's discover() uses (greenhouse.ts/lever.ts/ashby.ts)
// but without the content/compensation query params — a validation pass only
// needs a 200 + a count, not the full payload, across thousands of slugs.
// Never throws: a validation pass over many slugs needs a per-slug result,
// not a batch-crashing exception (mirrors greenhouse.ts's extractQuestions
// "return null, never throw" posture).
import { ConnectorHttpError, fetchJson } from "../connectors/_http";
import type { AtsConnector } from "./csv";

export interface ValidationResult {
  ok: boolean;
  status?: number;
  jobCount?: number;
}

function endpointFor(connector: AtsConnector, slug: string): string {
  if (connector === "greenhouse") return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
  if (connector === "lever") return `https://api.lever.co/v0/postings/${slug}`;
  return `https://api.ashbyhq.com/posting-api/job-board/${slug}`;
}

function countFor(connector: AtsConnector, json: unknown): number {
  if (connector === "lever") return Array.isArray(json) ? json.length : 0;
  const jobs = (json as { jobs?: unknown[] })?.jobs;
  return Array.isArray(jobs) ? jobs.length : 0;
}

export async function validateSlug(connector: AtsConnector, slug: string): Promise<ValidationResult> {
  try {
    const json = await fetchJson(endpointFor(connector, slug));
    return { ok: true, status: 200, jobCount: countFor(connector, json) };
  } catch (err) {
    if (err instanceof ConnectorHttpError) return { ok: false, status: err.status };
    return { ok: false };
  }
}
```
- [ ] **Step 4: Run test to verify it passes** — `npx vitest run src/server/search/companyList/validate.test.ts -t "validateSlug"` — Expected: PASS (5 tests).
- [ ] **Step 5: Commit**
```
git add src/server/search/companyList/validate.ts src/server/search/companyList/validate.test.ts
git commit -m "feat(search): per-connector HTTP-200 slug validation for the company-list engine"
```

---

### Task 5: Bulk seed + SEA slugs
**Files:** Create `src/server/search/companyList/bulkSeed.ts`, `src/server/search/companyList/bulkSeed.test.ts`

**Manual pre-task — do NOT invent:** Aspire's real ATS connector + slug is **UNKNOWN** (the literal slug `aspire` 404s live, per spec grounding). Resolving it (find Aspire's actual careers page, identify its ATS, confirm the real slug via `validateSlug`) is a manual pre-task. Aspire is deliberately **absent** from `SEA_SEEDS` below until resolved.

**Interfaces:**
- Consumes: `AtsConnector` (Task 2), `validateSlug`/`ValidationResult` (Task 4), `NewSource`/`SourceRow` (`@/server/persistence/repos/sources`), `SourceConfig` (Task 1), `sources` table (`@/server/persistence/schema`), `Db` (`@/server/persistence/repos/db`).
- Produces: `interface NicheCompany`, `SEA_SEEDS: NicheCompany[]`, `RAMP_LIMIT`, `toSourceRow(company, validation, enabled): NewSource`, `validateAndRank(companies): Promise<{company, validation}[]>`, `buildRampedSourceRows(validated, rampLimit?): NewSource[]`, `bulkSeedSources(db, rows): Promise<SourceRow[]>`.

- [ ] **Step 1: Write the failing test**
```ts
// src/server/search/companyList/bulkSeed.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/persistence/test-db";
import {
  SEA_SEEDS,
  buildRampedSourceRows,
  bulkSeedSources,
  toSourceRow,
  validateAndRank,
  type NicheCompany,
} from "./bulkSeed";

describe("toSourceRow", () => {
  it("builds a NewSource with health fields from a successful validation", () => {
    const company: NicheCompany = {
      name: "Vercel", connector: "greenhouse", slug: "vercel",
      companyDomain: "vercel.com", provenance: ["jobhive", "yc-oss"], geo: { scope: "anywhere" },
    };
    const row = toSourceRow(company, { ok: true, status: 200, jobCount: 87 }, true);
    expect(row.id).toBe("gh-vercel");
    expect(row.kind).toBe("ats");
    expect(row.persona).toBe("remote");
    expect(row.enabled).toBe(true);
    expect(row.config).toMatchObject({
      connector: "greenhouse", slug: "vercel", companyDomain: "vercel.com",
      jobCount: 87, consecutiveFailures: 0, status: "active",
    });
  });

  it("defaults geo.scope to restricted when the company has none (bulk-ingested, no per-company research)", () => {
    const company: NicheCompany = { name: "Acme", connector: "lever", slug: "acme", provenance: ["jobhive"] };
    const row = toSourceRow(company, { ok: true, status: 200, jobCount: 3 }, false);
    expect((row.config as { geo?: { scope?: string } }).geo?.scope).toBe("restricted");
  });

  it("throws — never seeds a slug that failed validation", () => {
    const company: NicheCompany = { name: "Aspire", connector: "greenhouse", slug: "aspire", provenance: ["jobhive"] };
    expect(() => toSourceRow(company, { ok: false, status: 404 }, false)).toThrow(/failed validation/);
  });
});

describe("buildRampedSourceRows", () => {
  it("enables only the top rampLimit companies by jobCount, holds the rest disabled, drops failed validations", () => {
    const validated = [
      { company: { name: "A", connector: "greenhouse", slug: "a", provenance: [] } as NicheCompany, validation: { ok: true, status: 200, jobCount: 10 } },
      { company: { name: "B", connector: "greenhouse", slug: "b", provenance: [] } as NicheCompany, validation: { ok: true, status: 200, jobCount: 50 } },
      { company: { name: "C", connector: "greenhouse", slug: "c", provenance: [] } as NicheCompany, validation: { ok: false, status: 404 } },
    ];
    const rows = buildRampedSourceRows(validated, 1);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === "gh-b")?.enabled).toBe(true);
    expect(rows.find((r) => r.id === "gh-a")?.enabled).toBe(false);
    expect(rows.some((r) => r.id === "gh-c")).toBe(false);
  });
});

describe("bulkSeedSources", () => {
  it("inserts rows and is idempotent (onConflictDoNothing) on a re-run", async () => {
    const db = await createTestDb();
    const rows = [
      toSourceRow({ name: "Vercel", connector: "greenhouse", slug: "vercel", provenance: ["jobhive"] }, { ok: true, status: 200, jobCount: 5 }, true),
    ];
    expect(await bulkSeedSources(db, rows)).toHaveLength(1);
    expect(await bulkSeedSources(db, rows)).toHaveLength(0);
  });
});

describe("SEA_SEEDS", () => {
  it("contains exactly the 3 live-verified slugs, never Aspire", () => {
    expect(SEA_SEEDS.map((c) => c.slug)).toEqual(["GoToGroup", "shopback-2", "bjakcareer"]);
    expect(SEA_SEEDS.some((c) => c.name.toLowerCase().includes("aspire"))).toBe(false);
  });
});

describe("validateAndRank", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("validates every company and pairs it with its ValidationResult", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ jobs: [{}, {}] }), { status: 200 })));
    const result = await validateAndRank([{ name: "Vercel", connector: "greenhouse", slug: "vercel", provenance: ["jobhive"] }]);
    expect(result[0].validation).toEqual({ ok: true, status: 200, jobCount: 2 });
  });
});
```
- [ ] **Step 2: Run test to verify it fails** — `npx vitest run src/server/search/companyList/bulkSeed.test.ts -t "toSourceRow"` — Expected: FAIL (module `./bulkSeed` doesn't exist).
- [ ] **Step 3: Write minimal implementation**
```ts
// src/server/search/companyList/bulkSeed.ts
// Bulk-seeds validated niche companies into `sources` (spec §4.3 steps 3-4,
// spine §3.4-3.5). Validates every candidate slug (HTTP 200 required — the
// Aspire 404 is why) with per-host politeness via p-limit, then inserts in
// small sequential batches (never one giant statement, never concurrent —
// libsql `file:` posture).
import pLimit from "p-limit";
import { sources } from "@/server/persistence/schema";
import type { Db } from "@/server/persistence/repos/db";
import type { NewSource, SourceRow } from "@/server/persistence/repos/sources";
import type { SourceConfig } from "@/types";
import type { AtsConnector } from "./csv";
import { validateSlug, type ValidationResult } from "./validate";

const BATCH_SIZE = 200;
const CONCURRENCY_PER_HOST = 3; // spec §4.3 step 3: ≤2–4 concurrent per vendor host

export interface NicheCompany {
  name: string;
  connector: AtsConnector;
  slug: string;
  companyDomain?: string;
  provenance: string[];
  geo?: { scope: "anywhere" | "restricted"; regions?: string[] };
}

// The 3 SEA slugs live-verified 2026-07-16 (spec grounding) — seeded
// immediately, enabled. Aspire is deliberately NOT here: its real ATS slug is
// UNKNOWN (`aspire` 404s live) — resolving it is a manual pre-task, never a
// guessed value (see Task 5's manual pre-task note).
export const SEA_SEEDS: NicheCompany[] = [
  { name: "GoTo Group", connector: "lever", slug: "GoToGroup", provenance: ["manual-sea"], geo: { scope: "restricted", regions: ["APAC"] } },
  { name: "ShopBack", connector: "lever", slug: "shopback-2", provenance: ["manual-sea"], geo: { scope: "restricted", regions: ["APAC"] } },
  { name: "Bjak", connector: "ashby", slug: "bjakcareer", provenance: ["manual-sea"], geo: { scope: "restricted", regions: ["APAC"] } },
];

function prefixFor(connector: AtsConnector): string {
  return connector === "greenhouse" ? "gh" : connector; // matches seed.ts's existing gh-/lever-/ashby- id convention
}

export function toSourceRow(company: NicheCompany, validation: ValidationResult, enabled: boolean): NewSource {
  if (!validation.ok) {
    throw new Error(
      `toSourceRow: "${company.slug}" (${company.connector}) failed validation (status ${validation.status ?? "network error"}) — never seed an unvalidated slug`,
    );
  }
  const config: SourceConfig = {
    connector: company.connector,
    slug: company.slug,
    // Bulk-ingested companies have no per-company geo research behind them
    // (unlike the 12 hand-seeded rows) — "restricted" is the conservative
    // default: a bare "Remote" reads unknown rather than wrongly granting
    // eligibility (spec §4.3 step 2: let the per-posting geo filter decide).
    geo: company.geo ?? { scope: "restricted" },
    provenance: company.provenance,
    ...(company.companyDomain ? { companyDomain: company.companyDomain } : {}),
    lastValidatedAt: new Date().toISOString(),
    jobCount: validation.jobCount ?? 0,
    consecutiveFailures: 0,
    status: "active",
  };
  return {
    id: `${prefixFor(company.connector)}-${company.slug.toLowerCase()}`,
    name: company.name,
    kind: "ats",
    persona: "remote",
    enabled,
    config,
  };
}

export async function validateAndRank(
  companies: NicheCompany[],
): Promise<{ company: NicheCompany; validation: ValidationResult }[]> {
  const limits: Record<AtsConnector, ReturnType<typeof pLimit>> = {
    greenhouse: pLimit(CONCURRENCY_PER_HOST),
    lever: pLimit(CONCURRENCY_PER_HOST),
    ashby: pLimit(CONCURRENCY_PER_HOST),
  };
  return Promise.all(
    companies.map((company) =>
      limits[company.connector](async () => ({ company, validation: await validateSlug(company.connector, company.slug) })),
    ),
  );
}

// Ramp to ~200–300 enabled (spec §6 step 2, spine §3.5) — 250 is the
// midpoint, an explicit operator-adjustable choice, not a spec-fixed number.
// Ranks by validated jobCount desc so the highest-signal companies go live
// first; the rest are bulk-inserted disabled (never dropped — the existing
// /sources admin toggle can enable any of them later).
export const RAMP_LIMIT = 250;

export function buildRampedSourceRows(
  validated: { company: NicheCompany; validation: ValidationResult }[],
  rampLimit: number = RAMP_LIMIT,
): NewSource[] {
  const ranked = validated
    .filter((v) => v.validation.ok)
    .sort((a, b) => (b.validation.jobCount ?? 0) - (a.validation.jobCount ?? 0));
  return ranked.map((v, i) => toSourceRow(v.company, v.validation, i < rampLimit));
}

export async function bulkSeedSources(db: Db, rows: NewSource[]): Promise<SourceRow[]> {
  const inserted: SourceRow[] = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const result = await db.insert(sources).values(batch).onConflictDoNothing().returning();
    inserted.push(...result);
  }
  return inserted;
}
```
- [ ] **Step 4: Run test to verify it passes** — `npx vitest run src/server/search/companyList/bulkSeed.test.ts -t "toSourceRow"` — Expected: PASS (9 tests across the file).
- [ ] **Step 5: Commit**
```
git add src/server/search/companyList/bulkSeed.ts src/server/search/companyList/bulkSeed.test.ts
git commit -m "feat(search): bulk-seed validated niche sources + SEA seeds, ramp enabled subset"
```

---

### Task 6: ATS re-detection from a careers page
**Files:** Create `src/server/search/companyList/redetect.ts`, `src/server/search/companyList/redetect.test.ts`
**Interfaces:**
- Consumes: `fetchText` (`../connectors/_http`), `AtsConnector` (Task 2).
- Produces: `interface RedetectResult { connector: AtsConnector; slug: string }`, `redetectAtsFromHtml(html: string): RedetectResult | null`, `redetectFromCareersUrl(careersUrl: string): Promise<RedetectResult | null>`.

- [ ] **Step 1: Write the failing test**
```ts
// src/server/search/companyList/redetect.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { redetectAtsFromHtml, redetectFromCareersUrl } from "./redetect";

describe("redetectAtsFromHtml", () => {
  it("finds a legacy-host greenhouse link", () => {
    expect(redetectAtsFromHtml('<a href="https://boards.greenhouse.io/acme">Careers</a>')).toEqual({ connector: "greenhouse", slug: "acme" });
  });

  it("finds the new job-boards.greenhouse.io host (the same host trap as ingest)", () => {
    expect(redetectAtsFromHtml('<a href="https://job-boards.greenhouse.io/acme">Careers</a>')).toEqual({ connector: "greenhouse", slug: "acme" });
  });

  it("finds a lever link", () => {
    expect(redetectAtsFromHtml('<a href="https://jobs.lever.co/acme">Careers</a>')).toEqual({ connector: "lever", slug: "acme" });
  });

  it("finds an ashby link", () => {
    expect(redetectAtsFromHtml('<a href="https://jobs.ashbyhq.com/acme">Careers</a>')).toEqual({ connector: "ashby", slug: "acme" });
  });

  it("returns null when the page has no ATS signature", () => {
    expect(redetectAtsFromHtml("<html><body>We're hiring! Email us.</body></html>")).toBeNull();
  });
});

describe("redetectFromCareersUrl", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches the careers URL and scans the body for an ATS signature", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('<a href="https://jobs.ashbyhq.com/acme">Careers</a>', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await redetectFromCareersUrl("https://acme.com")).toEqual({ connector: "ashby", slug: "acme" });
    expect(fetchMock).toHaveBeenCalledWith("https://acme.com", expect.anything());
  });
});
```
- [ ] **Step 2: Run test to verify it fails** — `npx vitest run src/server/search/companyList/redetect.test.ts -t "redetectAtsFromHtml"` — Expected: FAIL (module `./redetect` doesn't exist).
- [ ] **Step 3: Write minimal implementation**
```ts
// src/server/search/companyList/redetect.ts
// ATS re-detection from a company's careers page (spec §4.3 step 5, spine
// §3.6): when a source crosses the dead threshold, fetch its careers page and
// look for a live ATS-board link — Lever→Ashby moves are common. Unanchored
// signature regexes (scanning arbitrary HTML), unlike csv.ts's anchored
// per-row SLUG_PATTERNS — same host-trap fix applied (both greenhouse hosts).
import { fetchText } from "../connectors/_http";
import type { AtsConnector } from "./csv";

export interface RedetectResult {
  connector: AtsConnector;
  slug: string;
}

const CONNECTOR_ORDER: AtsConnector[] = ["greenhouse", "lever", "ashby"];

const ATS_SIGNATURE_PATTERNS: Record<AtsConnector, RegExp> = {
  greenhouse: /(?:boards|job-boards)\.greenhouse\.io\/([\w-]+)/,
  lever: /jobs\.lever\.co\/([\w-]+)/,
  ashby: /jobs\.ashbyhq\.com\/([\w.-]+)/,
};

export function redetectAtsFromHtml(html: string): RedetectResult | null {
  for (const connector of CONNECTOR_ORDER) {
    const match = ATS_SIGNATURE_PATTERNS[connector].exec(html);
    if (match) return { connector, slug: match[1] };
  }
  return null;
}

export async function redetectFromCareersUrl(careersUrl: string): Promise<RedetectResult | null> {
  const html = await fetchText(careersUrl);
  return redetectAtsFromHtml(html);
}
```
- [ ] **Step 4: Run test to verify it passes** — `npx vitest run src/server/search/companyList/redetect.test.ts -t "redetectAtsFromHtml"` — Expected: PASS (6 tests).
- [ ] **Step 5: Commit**
```
git add src/server/search/companyList/redetect.ts src/server/search/companyList/redetect.test.ts
git commit -m "feat(search): re-detect a moved ATS connector from a careers page's HTML"
```

---

### Task 7: Weekly revalidation + freshness cron wiring
**Files:** Create `src/server/search/companyList/revalidate.ts`, `src/server/search/companyList/revalidate.test.ts`, `src/server/search/companyList/revalidateCron.ts` · Modify `src/server/persistence/repos/sources.ts`, `package.json`, `DEPLOY.md`
**Interfaces:**
- Consumes: `SourceConfig` (Task 1), `AtsConnector` (Task 2), `validateSlug` (Task 4), `redetectFromCareersUrl` (Task 6), `createSourcesRepo`/`SourceRow` (`@/server/persistence/repos/sources`), `Db`.
- Produces: `interface RevalidateSummary { checked; healthy; failed; nowDead; redetected }`, `revalidateEnabledSources(db: Db): Promise<RevalidateSummary>`; adds `sourcesRepo.updateConfig(id, config)`.

- [ ] **Step 1: Write the failing test**
```ts
// src/server/search/companyList/revalidate.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/persistence/test-db";
import { revalidateEnabledSources } from "./revalidate";

function stubFetch(dispatch: (url: string) => Response) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => dispatch(url)));
}

describe("revalidateEnabledSources", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("increments consecutiveFailures on a single failed validation, without marking dead", async () => {
    const db = await createTestDb();
    await db.insert((await import("@/server/persistence/schema")).sources).values({
      id: "gh-acme", name: "Acme", kind: "ats", persona: "remote", enabled: true,
      config: { connector: "greenhouse", slug: "acme", consecutiveFailures: 1, status: "active" },
    });
    stubFetch(() => new Response("not found", { status: 404 }));

    const summary = await revalidateEnabledSources(db);
    expect(summary).toEqual({ checked: 1, healthy: 0, failed: 1, nowDead: 0, redetected: 0 });

    const { createSourcesRepo } = await import("@/server/persistence/repos/sources");
    const fetched = await createSourcesRepo(db).getById("gh-acme");
    expect((fetched?.config as { consecutiveFailures?: number })?.consecutiveFailures).toBe(2);
    expect((fetched?.config as { status?: string })?.status).toBe("active");
  });

  it("resets consecutiveFailures to 0 and updates jobCount on success", async () => {
    const db = await createTestDb();
    const { sources } = await import("@/server/persistence/schema");
    await db.insert(sources).values({
      id: "gh-acme", name: "Acme", kind: "ats", persona: "remote", enabled: true,
      config: { connector: "greenhouse", slug: "acme", consecutiveFailures: 2, status: "active" },
    });
    stubFetch(() => new Response(JSON.stringify({ jobs: [{}, {}, {}, {}, {}] }), { status: 200 }));

    const summary = await revalidateEnabledSources(db);
    expect(summary.healthy).toBe(1);

    const { createSourcesRepo } = await import("@/server/persistence/repos/sources");
    const fetched = await createSourcesRepo(db).getById("gh-acme");
    const config = fetched?.config as { consecutiveFailures?: number; jobCount?: number; status?: string };
    expect(config.consecutiveFailures).toBe(0);
    expect(config.jobCount).toBe(5);
    expect(config.status).toBe("active");
  });

  it("crosses the dead threshold, re-detects a moved ATS (lever→ashby) from companyDomain, rewrites config in place", async () => {
    const db = await createTestDb();
    const { sources } = await import("@/server/persistence/schema");
    await db.insert(sources).values({
      id: "lever-acme", name: "Acme", kind: "ats", persona: "remote", enabled: true,
      config: { connector: "lever", slug: "acme-old", consecutiveFailures: 2, companyDomain: "acme.com", provenance: ["jobhive"], status: "active" },
    });
    stubFetch((url) => {
      if (url.includes("api.lever.co")) return new Response("not found", { status: 404 });
      if (url.includes("acme.com")) return new Response('<a href="https://jobs.ashbyhq.com/acme">Careers</a>', { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });

    const summary = await revalidateEnabledSources(db);
    expect(summary).toEqual({ checked: 1, healthy: 0, failed: 1, nowDead: 1, redetected: 1 });

    const { createSourcesRepo } = await import("@/server/persistence/repos/sources");
    const fetched = await createSourcesRepo(db).getById("lever-acme");
    const config = fetched?.config as { connector?: string; slug?: string; consecutiveFailures?: number; status?: string; provenance?: string[] };
    expect(config.connector).toBe("ashby");
    expect(config.slug).toBe("acme");
    expect(config.consecutiveFailures).toBe(0);
    expect(config.status).toBe("active");
    expect(config.provenance).toContain("re-detected");
  });

  it("crosses the dead threshold and stays dead when re-detection finds nothing", async () => {
    const db = await createTestDb();
    const { sources } = await import("@/server/persistence/schema");
    await db.insert(sources).values({
      id: "lever-defunct", name: "Defunct", kind: "ats", persona: "remote", enabled: true,
      config: { connector: "lever", slug: "defunct", consecutiveFailures: 2, companyDomain: "defunct.com", status: "active" },
    });
    stubFetch((url) => {
      if (url.includes("api.lever.co")) return new Response("not found", { status: 404 });
      return new Response("<html><body>Gone</body></html>", { status: 200 });
    });

    const summary = await revalidateEnabledSources(db);
    expect(summary.nowDead).toBe(1);
    expect(summary.redetected).toBe(0);

    const { createSourcesRepo } = await import("@/server/persistence/repos/sources");
    const fetched = await createSourcesRepo(db).getById("lever-defunct");
    expect((fetched?.config as { status?: string })?.status).toBe("dead");
  });

  it("skips disabled sources and non-ats (board) sources", async () => {
    const db = await createTestDb();
    const { sources } = await import("@/server/persistence/schema");
    await db.insert(sources).values([
      { id: "gh-disabled", name: "Disabled", kind: "ats", persona: "remote", enabled: false, config: { connector: "greenhouse", slug: "x" } },
      { id: "jobstreet", name: "JobStreet", kind: "board", persona: "local", enabled: true, config: { country: "MY" } },
    ]);
    stubFetch(() => {
      throw new Error("should never be called for disabled/board sources");
    });

    const summary = await revalidateEnabledSources(db);
    expect(summary).toEqual({ checked: 0, healthy: 0, failed: 0, nowDead: 0, redetected: 0 });
  });
});
```
- [ ] **Step 2: Run test to verify it fails** — `npx vitest run src/server/search/companyList/revalidate.test.ts -t "revalidateEnabledSources"` — Expected: FAIL (module `./revalidate` doesn't exist).
- [ ] **Step 3: Write minimal implementation**

First, add `updateConfig` to `src/server/persistence/repos/sources.ts` (mirrors `setEnabled` exactly):
```ts
// inside createSourcesRepo(db) { return { ... } } — add alongside setEnabled:
    async updateConfig(id: string, config: Record<string, unknown>): Promise<SourceRow | undefined> {
      const [updated] = await db.update(sources).set({ config }).where(eq(sources.id, id)).returning();
      return updated;
    },
```
```ts
// and on the exported singleton wrapper, alongside setEnabled:
  updateConfig: (id, config) => createSourcesRepo(getDb()).updateConfig(id, config),
```

Then `src/server/search/companyList/revalidate.ts`:
```ts
// Weekly source-health pass (spec §4.3 step 5, spine §3.6): revalidates every
// enabled ATS source's slug; at 3 consecutive failures the row is marked dead
// and re-detection is attempted from its careers page before giving up. Runs
// via `npm run sources:revalidate` (a host cron entry — see DEPLOY.md).
import pLimit from "p-limit";
import { createSourcesRepo, type SourceRow } from "@/server/persistence/repos/sources";
import type { Db } from "@/server/persistence/repos/db";
import { SourceConfig } from "@/types";
import type { AtsConnector } from "./csv";
import { redetectFromCareersUrl } from "./redetect";
import { validateSlug } from "./validate";

const DEAD_THRESHOLD = 3;
const CONCURRENCY_PER_HOST = 3;

export interface RevalidateSummary {
  checked: number;
  healthy: number;
  failed: number;
  nowDead: number;
  redetected: number;
}

// `careersUrl` isn't a named SourceConfig field (spine §3.1) — it rides the
// schema's `.passthrough()` for sources seeded from a dataset that ships one
// (remoteintech's careers_url). Falling back to the bare companyDomain
// homepage is a best-effort guess when it's absent, never a fabricated path.
function careersUrlFor(config: SourceConfig): string | null {
  const passthrough = config as unknown as { careersUrl?: unknown };
  if (typeof passthrough.careersUrl === "string") return passthrough.careersUrl;
  if (config.companyDomain) return `https://${config.companyDomain}`;
  return null;
}

async function revalidateOne(db: Db, source: SourceRow, summary: RevalidateSummary): Promise<void> {
  const repo = createSourcesRepo(db);
  const config = SourceConfig.parse(source.config);
  const connector = config.connector as AtsConnector;
  if (!config.slug) throw new Error(`revalidate: source "${source.id}" (ats/${connector}) has no config.slug`);

  const result = await validateSlug(connector, config.slug);
  if (result.ok) {
    summary.healthy += 1;
    await repo.updateConfig(source.id, {
      ...config,
      lastValidatedAt: new Date().toISOString(),
      jobCount: result.jobCount ?? 0,
      consecutiveFailures: 0,
      status: "active",
    });
    return;
  }

  summary.failed += 1;
  const consecutiveFailures = (config.consecutiveFailures ?? 0) + 1;
  if (consecutiveFailures < DEAD_THRESHOLD) {
    await repo.updateConfig(source.id, { ...config, consecutiveFailures, lastValidatedAt: new Date().toISOString() });
    return;
  }

  summary.nowDead += 1;
  const careersUrl = careersUrlFor(config);
  const redetected = careersUrl ? await redetectFromCareersUrl(careersUrl).catch(() => null) : null;
  if (redetected) {
    summary.redetected += 1;
    await repo.updateConfig(source.id, {
      ...config,
      connector: redetected.connector,
      slug: redetected.slug,
      consecutiveFailures: 0,
      status: "active",
      lastValidatedAt: new Date().toISOString(),
      provenance: [...(config.provenance ?? []), "re-detected"],
    });
  } else {
    await repo.updateConfig(source.id, { ...config, consecutiveFailures, status: "dead", lastValidatedAt: new Date().toISOString() });
  }
}

export async function revalidateEnabledSources(db: Db): Promise<RevalidateSummary> {
  const repo = createSourcesRepo(db);
  const all = await repo.listAll();
  const candidates = all.filter((s) => s.enabled && s.kind === "ats");

  const summary: RevalidateSummary = { checked: candidates.length, healthy: 0, failed: 0, nowDead: 0, redetected: 0 };
  const limits: Record<AtsConnector, ReturnType<typeof pLimit>> = {
    greenhouse: pLimit(CONCURRENCY_PER_HOST),
    lever: pLimit(CONCURRENCY_PER_HOST),
    ashby: pLimit(CONCURRENCY_PER_HOST),
  };

  await Promise.all(
    candidates.map((source) => {
      const connector = (source.config as { connector?: string }).connector as AtsConnector;
      const limit = limits[connector];
      if (!limit) throw new Error(`revalidate: source "${source.id}" has kind "ats" but unknown connector "${connector}"`);
      return limit(() => revalidateOne(db, source, summary));
    }),
  );

  return summary;
}
```

Then `src/server/search/companyList/revalidateCron.ts` (mirrors `seed.ts`'s module-main guard):
```ts
import { fileURLToPath } from "node:url";
import { getDb } from "@/server/persistence/db";
import { revalidateEnabledSources } from "./revalidate";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = getDb();
  revalidateEnabledSources(db)
    .then((summary) => {
      console.log(
        `sources revalidate: checked ${summary.checked}, healthy ${summary.healthy}, failed ${summary.failed}, now dead ${summary.nowDead}, re-detected ${summary.redetected}`,
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
```

Then add to `package.json`'s `"scripts"` (alongside `eligibility:recompute`):
```
"sources:revalidate": "tsx --env-file-if-exists=.env.local src/server/search/companyList/revalidateCron.ts",
```

Then add to `DEPLOY.md`, directly after the existing "Nightly snapshot (floor)" cron section:
```
**Weekly source revalidation.** Cron on the host, mirroring the nightly backup entry above:
```
docker compose run --rm app npm run sources:revalidate
```
```
- [ ] **Step 4: Run test to verify it passes** — `npx vitest run src/server/search/companyList/revalidate.test.ts -t "revalidateEnabledSources"` — Expected: PASS (5 tests).
- [ ] **Step 5: Commit**
```
git add src/server/search/companyList/revalidate.ts src/server/search/companyList/revalidate.test.ts \
        src/server/search/companyList/revalidateCron.ts src/server/persistence/repos/sources.ts \
        package.json DEPLOY.md
git commit -m "feat(search): weekly source revalidation + re-detection cron entry"
```

---

### Task 8: Admin dead-count surface
**Files:** Create `src/app/api/admin/sources/route.ts`, `src/app/api/admin/sources/route.test.ts` · Modify `src/types/index.ts`, `src/features/admin/client.ts`, `src/app/(app)/admin/page.tsx`
**Interfaces:**
- Produces: `AdminSourcesStats` Zod schema (`{ total: number; enabled: number; dead: number }`), `GET /api/admin/sources`, `getAdminSourcesStats(): Promise<AdminSourcesStats>`.
- Consumes: `sourcesRepo.listAll()`, `SourceConfig.parse` (Task 1), `requireAdmin()`.

- [ ] **Step 1: Write the failing test**
```ts
// src/app/api/admin/sources/route.test.ts
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/errors";
import { sources } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { requireAdmin } = vi.hoisted(() => ({ requireAdmin: vi.fn() }));
vi.mock("@/server/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/server/auth/session")>()),
  requireAdmin: () => requireAdmin(),
}));

const { GET } = await import("./route");

describe("GET /api/admin/sources", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  beforeEach(() => {
    requireAdmin.mockReset();
    requireAdmin.mockResolvedValue({ id: "admin-1", email: "admin@example.com", role: "admin" });
  });

  afterEach(async () => {
    await state.testDb.delete(sources);
  });

  it("401s with UNAUTHORIZED when there is no session", async () => {
    requireAdmin.mockRejectedValue(new UnauthorizedError());
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("403s with FORBIDDEN for a non-admin", async () => {
    requireAdmin.mockRejectedValue(new ForbiddenError());
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("200s with total/enabled/dead counts over ATS sources only", async () => {
    await state.testDb.insert(sources).values([
      { id: "gh-a", name: "A", kind: "ats", persona: "remote", enabled: true, config: { connector: "greenhouse", slug: "a", status: "active" } },
      { id: "gh-b", name: "B", kind: "ats", persona: "remote", enabled: true, config: { connector: "greenhouse", slug: "b", status: "dead" } },
      { id: "gh-c", name: "C", kind: "ats", persona: "remote", enabled: false, config: { connector: "greenhouse", slug: "c", status: "dead" } },
      { id: "jobstreet", name: "JobStreet", kind: "board", persona: "local", enabled: true, config: { country: "MY" } },
    ]);

    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 3, enabled: 2, dead: 2 });
  });
});
```
- [ ] **Step 2: Run test to verify it fails** — `npx vitest run src/app/api/admin/sources/route.test.ts -t "GET /api/admin/sources"` — Expected: FAIL (route module doesn't exist).
- [ ] **Step 3: Write minimal implementation**

Add to `src/types/index.ts` (near `AdminUsersResponse`):
```ts
export const AdminSourcesStats = z.object({
  total: z.number().int(),
  enabled: z.number().int(),
  dead: z.number().int(),
});
export type AdminSourcesStats = z.infer<typeof AdminSourcesStats>;
```

`src/app/api/admin/sources/route.ts`:
```ts
// GET /api/admin/sources — dead-source count for the admin surface (spec
// §4.3 step 5: "a dead slug ... is visibly disabled with a count on an admin
// surface"; spine §3.6). requireAdmin()-guarded, mirrors GET /api/admin/users.
import { NextResponse } from "next/server";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/errors";
import { requireAdmin } from "@/server/auth/session";
import { sourcesRepo } from "@/server/persistence/repos/sources";
import { AdminSourcesStats, SourceConfig } from "@/types";
import type { ErrorEnvelope } from "@/types";

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string) {
  const body: ErrorEnvelope = { error: { code, message } };
  return NextResponse.json(body, { status });
}

export async function GET() {
  try {
    await requireAdmin();
    const rows = await sourcesRepo.listAll();
    const atsRows = rows.filter((r) => r.kind === "ats");
    const dead = atsRows.filter((r) => SourceConfig.parse(r.config).status === "dead").length;
    const enabled = atsRows.filter((r) => r.enabled).length;
    return NextResponse.json(AdminSourcesStats.parse({ total: atsRows.length, enabled, dead }), { status: 200 });
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    if (err instanceof ForbiddenError) return errorResponse(403, "FORBIDDEN", err.message);
    throw err;
  }
}
```

Add to `src/features/admin/client.ts`:
```ts
import { AdminSourcesStats, AdminUsersResponse, type AdminUser } from "@/types";
// ...(keep the existing getAdminUsers as-is, add:)
export async function getAdminSourcesStats(): Promise<AdminSourcesStats> {
  return requestJson("/api/admin/sources", undefined, AdminSourcesStats);
}
```

Modify `src/app/(app)/admin/page.tsx` — add state + effect + a stat line, right after the `<header>`, before the error/table block:
```tsx
// add to imports:
import { getAdminSourcesStats, getAdminUsers } from "@/features/admin/client";
import type { AdminSourcesStats } from "@/types";

// inside AdminPage(), alongside the existing state:
const [sourceStats, setSourceStats] = React.useState<AdminSourcesStats | null>(null);

React.useEffect(() => {
  void getAdminSourcesStats().then(setSourceStats).catch(() => {});
}, []);

// in the JSX, right after the closing </header> and before the {forbidden ? ... } block:
{sourceStats && (
  <div style={{ marginBottom: 16, font: "var(--type-body)", color: "var(--text-muted)" }}>
    Sources: {sourceStats.total} total · {sourceStats.enabled} enabled · {sourceStats.dead} dead
  </div>
)}
```
- [ ] **Step 4: Run test to verify it passes** — `npx vitest run src/app/api/admin/sources/route.test.ts -t "GET /api/admin/sources"` — Expected: PASS (3 tests).
- [ ] **Step 5: Commit**
```
git add src/app/api/admin/sources/route.ts src/app/api/admin/sources/route.test.ts \
        src/types/index.ts src/features/admin/client.ts "src/app/(app)/admin/page.tsx"
git commit -m "feat(admin): surface dead/enabled/total source counts on the admin page"
```

---

## Self-review

**1. Spec §4.3 coverage — each pipeline step maps to a task:**
- Step 1 (ingest jobhive CSVs) → Task 2. Step 2 (domain-join niche filter) → Task 3. Step 3 (validate, HTTP 200) → Task 4 (+ orchestrated in Task 5's `validateAndRank`). Step 4 (bulk-seed) → Task 5. Step 5 (freshness + re-detection loop, admin dead-count) → Tasks 6, 7, 8.
- Step 6 (growth loop: yc-oss daily diff, quarterly jobhive re-pull, manual SEA harvesting) is **deliberately out of scope** — it does not appear in the design spine's Wave 2 contract (§3.1–§3.6) or in this plan's "must deliver" brief; treating it as a later/ongoing-ops concern, not silently added here.
- Spec §5 tests: CSV parse (Task 2) ✓, domain-join (Task 3) ✓, host trap (Task 2, both directions — ingest AND re-detection) ✓, validation 200/404 handling (Task 4) ✓, `consecutiveFailures`→`dead`→re-detection rewriting config in place (Task 7) ✓.

**2. Placeholder/fabrication scan:**
- No invented dataset download URLs: jobhive (Task 2), yc-oss/remoteintech/topstartups.io (Task 3) are explicit manual pre-tasks with UNKNOWN marked.
- Aspire's real slug: explicit manual pre-task (Task 5), never guessed; `SEA_SEEDS` test pins its absence.
- The `companyDomain`-sourcing gap (Task 3) and the `careersUrl` passthrough-key gap (Task 7) are surfaced as open design questions, not silently resolved with invented logic — both call sites operate correctly on whatever the caller supplies, deferring the "where does the real value come from" question explicitly.
- No new npm dependency invented for CSV parsing or cron scheduling — both follow verified existing repo patterns (hand-rolled parser; host-level cron entry mirroring the nightly backup).

**3. Type consistency:**
- `SourceConfig` fields (`connector, slug, geo, provenance, companyDomain, lastValidatedAt, jobCount, consecutiveFailures, status`) are identical across Tasks 1, 5, 7, 8 — always read via `SourceConfig.parse(...)`, always written as a full spread (`{...config, ...overrides}`), never a partial hand-built object.
- `AtsConnector = "greenhouse" | "lever" | "ashby"` (Task 2) is the single source of truth for connector keys, imported (never redeclared) in Tasks 4, 5, 6, 7 — matches the existing `FACTORIES` registry keys in `connectors/index.ts`.
