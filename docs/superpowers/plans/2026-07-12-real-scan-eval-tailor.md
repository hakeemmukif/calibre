# Real Scan + Eval + Tailor (live sources, gpt-oss-120b, Sources page, Evaluate button, E2E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing scan→score pipeline work against REAL job sources for both personas (remote·global via Greenhouse/Lever/Ashby company boards, Malaysia·local via JobStreet MY), evaluated live with `openai/gpt-oss-120b` on OpenRouter; add a Sources page with per-source toggles, a per-job Evaluate endpoint + button; then cover everything with the deferred Playwright E2E suite.

**Architecture:** No new pipelines — the fan-out (`server/search/run.ts`), scoring (`server/score`), and tailor services already exist and are tested. This plan (1) replaces placeholder source seeds with one row per real company using a `config.connector` discriminator, (2) closes the description gap (only Lever ships descriptions today; unscored jobs are invisible in the feed), (3) points `config/models.yml` at `openai/gpt-oss-120b`, (4) adds two small contract surfaces (Sources list/toggle, per-job evaluate) and their UI, (5) builds the E2E harness deferred from the test-automation plan — adapted to the native Postgres now available (no Docker locally).

**Tech Stack:** Next.js 15 App Router, TypeScript, Drizzle + Postgres, Zod v4 contract (`src/types` → registry → `contract/openapi.json`), Vitest (+ pglite test DB), Playwright `@playwright/test`, OpenRouter (OpenAI-compatible).

## Global Constraints

- Layering: UI → `features/*` → `server/*`. Only `server/*` touches DB/LLM. (project CLAUDE.md)
- Fail loud: no fallback defaults, no silent `""`/`0`/`unknown`. Validate at boundaries with `Schema.parse`. Required-missing → throw specific error.
- Contract-first: any new endpoint/entity goes in `src/types` + `src/contract/registry.ts`, then `npm run contract` regenerates `contract/openapi.json` in the SAME commit; `route-coverage.test.ts` must pass.
- Branch invariant from the last merged review: malformed input → 4xx, never 500. UUID route params use `UuidParam`/`isUuid` from `src/server/http/params.ts`. (Source ids are TEXT natural keys, not UUIDs — they are exempt from the UUID guard but must still 404 cleanly on unknown ids.)
- Model: every task in `config/models.yml` uses `model: openai/gpt-oss-120b` with price `{ promptUsdPerMTok: 0.03, completionUsdPerMTok: 0.15 }` (donor-verified 2026-07-03). No other model ids.
- Test doubles seam: `CALIBER_TEST_DOUBLES=1` → fixture connector + mock LLM. It must stay default-off; only `"1"` enables; other non-empty values throw (existing `testDoublesEnabled()` semantics — do not weaken).
- No new prod dependencies. New dev dependency allowed: `@playwright/test` (version-matched to the existing `playwright` ^1.61.1).
- Descriptions are capped at 40_000 chars before persist/scoring (precedent: manual-url-scan spec §7 size cap).
- Existing 418 tests must stay green after every task (`npm test`); `npm run check` green at branch end.
- Working branch: `scan-eval-live` (created from `main` with the prior session's scan-UI WIP committed as the base commit — controller does this before Task 1).
- Donor repo (read-only reference): `/Users/hakeem/Projects/career-ops` (+ `careerops-web/`). Copy VALUES (slugs, prices, API params) from it; never import code from it.

---

### Task 1: Point `config/models.yml` at `openai/gpt-oss-120b`

**Files:**
- Modify: `config/models.yml`
- Test: `src/lib/llm/models.test.ts` (only if it pins current placeholder ids — check first)

**Interfaces:**
- Consumes: `src/lib/llm/models.ts` — `modelFor(task)`, `escalateModelFor(task)` (returns `escalateTo` or `null`), `priceFor(model)` (throws `No price entry for model "..."`).
- Produces: every `getLlm().complete({task})` call now resolves to `openai/gpt-oss-120b`.

- [ ] **Step 1: Read `src/lib/llm/models.ts` and `src/lib/llm/models.test.ts`** to confirm (a) whether `escalateTo` is optional in the parsed config shape (expected: yes — `escalateModelFor` returns `null` when absent), and (b) whether any test asserts the current placeholder model ids from the real `config/models.yml` (if tests use inline fixture YAML only, no test change is needed).

- [ ] **Step 2: Rewrite `config/models.yml`** — keep the task list, `maxTokens`, `temperature` exactly as-is; change every `model:` to `openai/gpt-oss-120b`; DELETE the `escalateTo` line from `match-score` (donor parity: no escalation valve; `escalateModelFor` returning `null` disables the `lowConfidence` re-run path in `server/score` without code changes — verify that by reading the escalation call site in `src/server/score/evalScores.ts` or `index.ts`); replace the whole `prices:` block with exactly:

```yaml
prices:
  openai/gpt-oss-120b: { promptUsdPerMTok: 0.03, completionUsdPerMTok: 0.15 }
```

Update the header comment: model ids confirmed by operator 2026-07-12 (donor `config/models.yml` runs the same model for evaluate/tailor/apply; prices verified 2026-07-03 in donor).

- [ ] **Step 3: Run the LLM-layer tests**

Run: `npx vitest run src/lib/llm`
Expected: PASS (if a test pinned a placeholder id from the real file, update that assertion to `openai/gpt-oss-120b` and re-run).

- [ ] **Step 4: Full suite**

Run: `npm test`
Expected: 418+ tests pass.

- [ ] **Step 5: Commit**

```bash
git add config/models.yml src/lib/llm/models.test.ts
git commit -m "feat(llm): route all tasks to openai/gpt-oss-120b (donor-verified pricing)"
```

---

### Task 2: Per-company source rows + `config.connector` resolution + JobStreet Malaysia config

**Files:**
- Modify: `src/server/search/connectors/index.ts:20-25` (resolution key)
- Modify: `src/server/persistence/seed.ts` (real seeds)
- Modify: `src/smoke/jobstreet.smoke.test.ts` (probe MY host/siteKey)
- Test: `src/server/search/connectors/index.test.ts` (or co-located existing test file for the registry — find it with `ls src/server/search/connectors/*.test.ts`)

**Interfaces:**
- Consumes: `SourceRow` from `src/server/persistence/repos/sources.ts` (`config` is `jsonb`).
- Produces: `connectorForSource` resolves `FACTORIES[(source.config as {connector?: string}).connector ?? source.id]`. Seed rows shaped `{ id: "gh-gitlab", name: "GitLab", kind: "ats", persona: "remote", enabled: true, config: { connector: "greenhouse", slug: "gitlab" } }`. Later tasks (Sources API/UI) rely on these ids/names.

- [ ] **Step 1: Write the failing registry test** — in the connectors registry test file, add:

```ts
it("resolves the connector from config.connector when present (per-company rows)", () => {
  const source = {
    id: "gh-gitlab", name: "GitLab", kind: "ats", persona: "remote",
    enabled: true, config: { connector: "greenhouse", slug: "gitlab" },
  } as SourceRow;
  const connector = connectorForSource(source);
  expect(connector.id).toBe("gh-gitlab");
});

it("still throws fail-loud for an unknown connector key", () => {
  const source = { id: "mystery", config: {} } as SourceRow;
  expect(() => connectorForSource(source)).toThrow(/No connector registered/);
});
```

(Match the existing test file's fixture style for `SourceRow` construction — read it first. Ensure `CALIBER_TEST_DOUBLES` is not set in these tests, mirroring how the existing registry tests handle it.)

- [ ] **Step 2: Run to verify the new test fails**

Run: `npx vitest run src/server/search/connectors`
Expected: FAIL — `No connector registered for source id "gh-gitlab"`.

- [ ] **Step 3: Implement resolution** in `connectors/index.ts`:

```ts
export function connectorForSource(source: SourceRow): SourceConnector {
  if (testDoublesEnabled()) return createFixtureConnector(source);
  const key = (source.config as { connector?: string })?.connector ?? source.id;
  const factory = FACTORIES[key];
  if (!factory) throw new Error(`No connector registered for source id "${source.id}" (connector key "${key}")`);
  return factory(source);
}
```

Update the file's header comment: keyed by `config.connector` (per-company rows, e.g. `gh-stripe`) falling back to `source.id` (canonical single-board rows: `jobstreet`, and the fixture/test seeds).

- [ ] **Step 4: Run to verify pass**: `npx vitest run src/server/search/connectors` → PASS.

- [ ] **Step 5: Build the real seed list.** Open `/Users/hakeem/Projects/career-ops/portals.yml` and read `tracked_companies`. Select 12 companies whose `careers_url` matches one of OUR three connectors, preferring this list where present (all remote-friendly): Stripe, GitLab, Ramp, Plaid, Airwallex, Deel, Remote, Toptal, ElevenLabs, Perplexity, Zapier, Supabase — fill any gaps with other `enabled: true` entries. Extract the slug with these exact rules (donor provider auto-detect rules):
  - `job-boards.greenhouse.io/<slug>` or `job-boards.eu.greenhouse.io/<slug>` → connector `greenhouse`, config `{ connector: "greenhouse", slug }`, id `gh-<slug>`
  - `jobs.lever.co/<slug>` → connector `lever`, config `{ connector: "lever", slug }`, id `lever-<slug>`
  - `jobs.ashbyhq.com/<slug>` → connector `ashby`, config `{ connector: "ashby", slug }`, id `ashby-<slug>`
  - Any other ATS (workday/smartrecruiters/workable/…) → SKIP, we have no connector for it.
  Do NOT invent slugs — every slug must come verbatim from a `careers_url` in the donor file. `name` = the donor entry's company name. All rows: `kind: "ats"`, `persona: "remote"`, `enabled: true`.

- [ ] **Step 6: Rewrite `src/server/persistence/seed.ts`'s `sourceSeeds`** with those 12 rows plus the Malaysia board row:

```ts
  {
    id: "jobstreet", name: "JobStreet Malaysia", kind: "board", persona: "local", enabled: true,
    config: {
      api: "https://my.jobstreet.com/api/chalice-search/v4/search",
      siteKey: "MY-Main",
      query: "software engineer",
      pageSize: 30,
      maxPages: 3,
    },
  },
```

(`my.jobstreet.com` is in the donor provider's host allow-list; `MY-Main` follows the donor's verified `ID-Main` siteKey pattern and is live-verified in Step 8. The connector already reads `api`/`siteKey`/`query`/`pageSize`/`maxPages` from config — `src/server/search/connectors/jobstreet.ts:77-84`.) Update the seed file's header comment (per-company rows, connector discriminator, donor provenance). Do NOT touch `seed-test.ts` — the fixture/E2E seam keeps the 4 canonical ids.

- [ ] **Step 7: Run the suite**: `npm test` → PASS (seed.ts has no unit test asserting the old rows — verify with `grep -rn "REPLACE_ME" src/` → only seed.ts should have had it, now zero).

- [ ] **Step 8: Update the JobStreet smoke test** (`src/smoke/jobstreet.smoke.test.ts` — read it first; keep its structure) so the live probe uses the new MY config values (api/siteKey above, keywords `software engineer`), asserts ≥1 item parses to a `RawPosting` with non-empty `title` and an `http(s)` `url`, and logs the first item's `title/company/location`. This is run manually in Task 7 (`npm run smoke:real`), never in CI.

- [ ] **Step 9: Commit**

```bash
git add src/server/search/connectors/index.ts src/server/search/connectors/*.test.ts src/server/persistence/seed.ts src/smoke/jobstreet.smoke.test.ts
git commit -m "feat(sources): per-company source rows via config.connector + real donor slugs + JobStreet MY config"
```

---

### Task 3: Capture descriptions at discover time (Greenhouse `content=true`, Ashby `descriptionHtml`)

**Files:**
- Create: `src/server/search/connectors/_html.ts`
- Modify: `src/server/search/connectors/greenhouse.ts`
- Modify: `src/server/search/connectors/ashby.ts`
- Test: `src/server/search/connectors/_html.test.ts`, plus the existing greenhouse/ashby connector test files (extend their fixtures)

**Interfaces:**
- Produces: `htmlToText(html: string): string` (strips `<script>`/`<style>` blocks and all tags, unescapes `&lt; &gt; &amp; &quot; &#39; &nbsp;`, collapses whitespace, trims) and `unescapeEntities(s: string): string` (same entity set, exported for greenhouse's escaped-HTML `content` field). Greenhouse/Ashby `RawPosting.description` now populated (capped at 40_000 chars). Lever already ships `descriptionPlain` — untouched. JobStreet handled in Task 4.

**Live-verification substep (no key needed, read-only GETs):** before coding, curl the real APIs once to pin exact field names, and paste a trimmed real item into the test fixtures:
- `curl -s "https://boards-api.greenhouse.io/v1/boards/gitlab/jobs?content=true" | head -c 2000` — confirm each job has a `content` field of HTML-escaped markup.
- `curl -s "https://api.ashbyhq.com/posting-api/job-board/<one-ashby-slug-from-Task-2>?includeCompensation=true" | head -c 2000` — confirm each job has `descriptionHtml` (raw HTML). If the field is absent or named differently, use what the live response actually shows; if no description-like field exists at all, report DONE_WITH_CONCERNS naming the actual response keys — do not invent.

- [ ] **Step 1: Write failing tests for `_html.ts`**

```ts
import { describe, expect, it } from "vitest";
import { htmlToText, unescapeEntities } from "./_html";

describe("htmlToText", () => {
  it("strips tags, script/style blocks, and collapses whitespace", () => {
    const html = `<div><h1>Senior  Engineer</h1><script>track()</script><style>.x{}</style><p>Build &amp; ship</p></div>`;
    expect(htmlToText(html)).toBe("Senior Engineer Build & ship");
  });
  it("handles greenhouse-style escaped HTML after unescapeEntities", () => {
    const escaped = "&lt;p&gt;Remote &amp;amp; async&lt;/p&gt;";
    expect(htmlToText(unescapeEntities(escaped))).toBe("Remote & async");
  });
});
```

- [ ] **Step 2: Run to fail**: `npx vitest run src/server/search/connectors/_html.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `_html.ts`**

```ts
// Minimal HTML→text for connector descriptions — no readability/cheerio in
// prod deps (manual-url-scan spec §7 precedent). Tag-strip THEN entity
// unescape, so escaped markup (greenhouse `content`) needs unescapeEntities
// first at the call site.
export function unescapeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return unescapeEntities(stripped).replace(/\s+/g, " ").trim();
}
```

(Note the double-unescape in the greenhouse test: `&amp;amp;` → `&amp;` → the call site applies `unescapeEntities` then `htmlToText` unescapes once more — the test pins that real-world behaviour.)

- [ ] **Step 4: Run to pass**, then extend the greenhouse connector: add `content=true` to the list URL it builds, extend `GreenhouseJob` with `content?: string`, and set on the yielded posting:

```ts
description: typeof j.content === "string" && j.content.trim().length > 0
  ? htmlToText(unescapeEntities(j.content)).slice(0, 40_000)
  : undefined,
```

Extend the existing greenhouse test fixture with a `content` field (use a trimmed REAL escaped-HTML snippet from the Step-0 curl) and assert the yielded posting's `description` is the plain-text form.

- [ ] **Step 5: Same for ashby**: extend its item interface with `descriptionHtml?: string` (or the live-confirmed field name), map `description: htmlToText(j.descriptionHtml).slice(0, 40_000)` when present, extend its test fixture + assertion.

- [ ] **Step 6: Full suite**: `npm test` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/search/connectors/_html.ts src/server/search/connectors/_html.test.ts src/server/search/connectors/greenhouse.ts src/server/search/connectors/ashby.ts src/server/search/connectors/*.test.ts
git commit -m "feat(connectors): capture job descriptions at discover time (greenhouse content=true, ashby descriptionHtml)"
```

---

### Task 4: `fetchDetail` for JobStreet + ensure-description hook in the scoring loop

**Files:**
- Modify: `src/server/search/connectors/jobstreet.ts` (implement `fetchDetail`)
- Create: `src/server/search/describe.ts`
- Modify: `src/server/search/run.ts:366-393` (scoring loop calls `ensureDescription`)
- Modify: `src/server/persistence/repos/jobs.ts` (add `updateDescription`)
- Test: `src/server/search/describe.test.ts`, jobstreet connector test file, repos test file

**Interfaces:**
- Consumes: `SourceConnector.fetchDetail?(p: RawPosting): Promise<{ description: string; applyUrl?: string }>` (already declared, `src/server/search/connector.ts:61`, implemented by nobody today); `connectorForSource` (Task 2); `htmlToText` (Task 3).
- Produces:
  - `jobsRepo.updateDescription(id: string, description: string): Promise<JobRow>` (throws if id unknown — fail loud).
  - `ensureDescription(job: JobRow, source: SourceRow): Promise<JobRow>` in `describe.ts` — returns `job` unchanged when it already has a non-empty description OR the connector has no `fetchDetail`; otherwise fetches detail, caps at 40_000 chars, persists via `updateDescription`, returns the updated row. Any fetch failure propagates (callers decide tolerance). Task 6 reuses this exact function.

- [ ] **Step 1: Implement `fetchDetail` on the jobstreet connector.** JobStreet job pages are server-rendered public HTML; fetch the posting's `url` with a browser-like User-Agent and 10s timeout (reuse `fetchText`-style helper if `_http.ts` has one — read `src/server/search/connectors/_http.ts` first; add a `fetchText` there mirroring `fetchJson` if it only has JSON), then:

```ts
async fetchDetail(p) {
  const html = await fetchText(p.url, { signal: AbortSignal.timeout(10_000) });
  const description = htmlToText(html).slice(0, 40_000);
  if (!description) throw new Error(`JobStreet detail page yielded no text: ${p.url}`);
  return { description };
},
```

Add a unit test with a small static HTML fixture served via a mocked `fetchText` (follow the connector test file's existing mocking pattern for `fetchJson`). Anti-bot walls are a live-run concern — Task 7 verifies against the real site; the unit test only pins parsing.

- [ ] **Step 2: Add `updateDescription` to `jobsRepo`** (mirror the repo's existing update style; `.returning()`; throw `new Error(\`jobsRepo.updateDescription: no job ${id}\`)` if zero rows). Unit test against the pglite test DB (existing repo-test pattern in the same file).

- [ ] **Step 3: Write `describe.ts` + failing tests**

```ts
import { connectorForSource } from "./connectors";
import { jobsRepo } from "@/server/persistence/repos/jobs";
import type { JobRow } from "@/server/persistence/repos/jobs";
import type { SourceRow } from "@/server/persistence/repos/sources";
import type { RawPosting } from "./connector";

const DESCRIPTION_CAP = 40_000;

// Top-N scoring path only — never called during fan-out persist, so detail
// fetches stay bounded at TOP_N_CANDIDATES per run.
export async function ensureDescription(job: JobRow, source: SourceRow): Promise<JobRow> {
  if (job.description && job.description.trim().length > 0) return job;
  const connector = connectorForSource(source);
  if (!connector.fetchDetail) return job;
  const posting: RawPosting = { sourceId: source.id, url: job.url, title: job.title, company: job.company };
  const detail = await connector.fetchDetail(posting);
  const description = detail.description.slice(0, DESCRIPTION_CAP);
  if (!description.trim()) return job;
  return jobsRepo.updateDescription(job.id, description);
}
```

(Adjust `RawPosting` construction to its actual required fields — read `connector.ts:20-30`. If `JobRow.url` is named differently (`applyUrl`?), read the repo type and use the real column.) Tests: (a) short-circuits when description present (no connector call — assert via a spy), (b) returns job unchanged when connector lacks `fetchDetail`, (c) fetches+persists when null description and connector provides detail (use pglite + a stub connector via `CALIBER_TEST_DOUBLES`? No — inject by testing against a seeded `jobstreet`-config row with `fetchText` mocked; follow whatever seam the connector tests already use).

- [ ] **Step 4: Hook into the scoring loop** in `run.ts` — inside the `try` at line ~373, before `scoreJob`:

```ts
const jobToScore = await ensureDescription(job, source).catch((err) => {
  console.error(`search run ${row.id}: detail fetch for job ${job.id} failed:`, err);
  return job; // scoreJob will throw EmptyJobDescriptionError → counted unscored
});
const scoreRow = await scoreJob({ job: jobToScore, resume, llm });
```

Update the `EmptyJobDescriptionError` comment (line 382-385): the connector had no `fetchDetail` OR the detail fetch failed.

- [ ] **Step 5: Full suite**: `npm test` → PASS (the spine/route tests run in doubles mode where the fixture connector has descriptions — confirm no regression).

- [ ] **Step 6: Commit**

```bash
git add src/server/search/connectors/jobstreet.ts src/server/search/connectors/_http.ts src/server/search/describe.ts src/server/search/describe.test.ts src/server/search/run.ts src/server/persistence/repos/jobs.ts src/server/persistence/repos/*.test.ts src/server/search/connectors/*.test.ts
git commit -m "feat(scan): ensureDescription hook — jobstreet fetchDetail + top-N detail backfill before scoring"
```

---

### Task 5: Sources contract + API (`GET /api/sources`, `PATCH /api/sources/:id`)

**Files:**
- Modify: `src/types/index.ts` (add `Source` entity)
- Modify: `src/server/persistence/repos/sources.ts` (add `listAll`, `setEnabled`)
- Create: `src/app/api/sources/route.ts`, `src/app/api/sources/[id]/route.ts`
- Modify: `src/contract/registry.ts` (+ `entitySchemas` if separate), then `npm run contract`
- Test: `src/app/api/sources/route.test.ts`, `src/app/api/sources/[id]/route.test.ts`, repos test file

**Interfaces:**
- Produces (wire, in `src/types/index.ts`, near `SourceRef`):

```ts
// Full source row for the Sources management page — includes disabled rows
// and the DB-only "both" persona (SourceRef stays the slim per-job ref).
export const Source = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["ats", "board"]),
  persona: z.enum(["remote", "local", "both"]),
  enabled: z.boolean(),
});
export type Source = z.infer<typeof Source>;
```

- `GET /api/sources` → `200 { items: Source[] }` (ALL rows, both personas, disabled included, ordered by name).
- `PATCH /api/sources/:id` body `{ enabled: boolean }` → `200 Source`; unknown id → `404 NOT_FOUND`; bad body → `422 VALIDATION_ERROR`.
- `sourcesRepo.listAll(): Promise<SourceRow[]>`; `sourcesRepo.setEnabled(id: string, enabled: boolean): Promise<SourceRow | undefined>` (undefined = unknown id).
- Task 8 (UI) consumes these endpoints via a new `features/sources/client.ts`.

- [ ] **Step 1: Repo methods + failing repo tests** (pglite pattern from the existing sources repo tests): `listAll` returns seeded rows ordered by name; `setEnabled` flips and returns the row; `setEnabled("nope", true)` resolves `undefined`.

- [ ] **Step 2: Implement repo methods** (drizzle `update ... set({enabled}) .where(eq(sources.id, id)).returning()`), run repo tests → PASS.

- [ ] **Step 3: Routes + failing route tests.** Mirror the thin-boundary style of `src/app/api/jobs/route.ts` (read it first): parse → repo → map. Route tests follow the existing route-test pattern (pglite seam). Assertions: GET returns every seeded row and each item passes `Source.parse`; PATCH flips `enabled` and a re-GET shows it persisted; PATCH unknown id → 404 envelope `NOT_FOUND`; PATCH `{enabled: "yes"}` → 422 `VALIDATION_ERROR`. The `[id]` param is a TEXT natural key — no `UuidParam` (note this in a comment, citing the branch invariant explicitly so the reviewer sees it's deliberate).

- [ ] **Step 4: Implement routes**, mapping rows through `Source.parse` (fail loud on drift), run route tests → PASS.

- [ ] **Step 5: Contract registration**: add `Source` to the entity schemas, `registerPath` for both routes (mirror an existing GET+PATCH pair — `applications/[id]` PATCH exists). Run `npm run contract`; commit the regenerated `contract/openapi.json`. Run `npx vitest run src/contract src/app/route-coverage.test.ts` (locate the exact route-coverage test path with `grep -rl "route-coverage" src`) → PASS.

- [ ] **Step 6: Full suite**: `npm test` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/types/index.ts src/server/persistence/repos/sources.ts src/app/api/sources contract/openapi.json src/contract/registry.ts src/server/persistence/repos/*.test.ts
git commit -m "feat(api): Sources contract — GET /api/sources + PATCH /api/sources/:id (enable toggle)"
```

---

### Task 6: Per-job Evaluate endpoint (`POST /api/jobs/:id/evaluate`)

**Files:**
- Create: `src/server/score/evaluate.ts`, `src/app/api/jobs/[id]/evaluate/route.ts`
- Modify: `src/server/persistence/repos/jobs.ts` (add `getRowWithSourceById`)
- Modify: `src/contract/registry.ts`, regenerate `contract/openapi.json`
- Test: `src/server/score/evaluate.test.ts`, `src/app/api/jobs/[id]/evaluate/route.test.ts`, repos test file

**Interfaces:**
- Consumes: `scoreJob({job, resume, llm})` (`src/server/score/index.ts:28`), `assembleJob` (`src/features/feed/assemble.ts:29`), `resolveIsNewCutoff` (find its definition in `src/server/search/` — reuse, do not duplicate), `ensureDescription` (Task 4), `resumesRepo.getActive()`, existing `NoActiveResumeError` (find where search's startSearch imports it and reuse the same class), `UuidParam`/`isUuid` (`src/server/http/params.ts`).
- Produces:
  - `jobsRepo.getRowWithSourceById(id: string): Promise<{ job: JobRow; source: SourceRow } | undefined>` (join on sourceId; undefined for unknown id).
  - `evaluateJob(jobId: string, deps?: { llm?: LlmClient }): Promise<Job>` in `evaluate.ts`, throwing `UnknownJobError` (new, exported) / `NoActiveResumeError` / `EmptyJobDescriptionError` (existing, from `server/score`).
  - `POST /api/jobs/{id}/evaluate` → `200 Job` | `404 NOT_FOUND` (malformed or unknown id) | `409 CONFLICT` (no active résumé) | `422 EXTRACTION_FAILED` (no description obtainable) | `500 INTERNAL` (unexpected). Task 9 (button) consumes this via `features/feed/client.ts`.

- [ ] **Step 1: Repo method + failing test** (pglite): seeded job+source → returns both rows; unknown uuid → undefined. Implement, PASS.

- [ ] **Step 2: `evaluate.ts` + failing tests** (doubles-mode LLM via `deps.llm ?? getLlm()` with `CALIBER_TEST_DOUBLES=1` in the test env, mirroring how `scoreJob`'s own tests inject):

```ts
export class UnknownJobError extends Error {
  constructor(id: string) { super(`Unknown job: ${id}`); }
}

export async function evaluateJob(jobId: string, deps: { llm?: LlmClient } = {}): Promise<Job> {
  const found = await jobsRepo.getRowWithSourceById(jobId);
  if (!found) throw new UnknownJobError(jobId);
  const resume = await resumesRepo.getActive();
  if (!resume) throw new NoActiveResumeError();
  const job = await ensureDescription(found.job, found.source).catch(() => found.job);
  const llm = deps.llm ?? getLlm();
  const score = await scoreJob({ job, resume, llm });
  const isNewCutoff = await resolveIsNewCutoff(found.job.persona);
  return assembleJob({ job, score, source: found.source }, { isNewCutoff });
}
```

(Fix imports/signatures against the real modules — e.g. `resolveIsNewCutoff`'s exact export site and `assembleJob`'s exact joined shape. If `resolveIsNewCutoff` is not exported from `run.ts`, export it — one-line change, note it in the report.) Tests: unknown id throws `UnknownJobError`; no active résumé throws `NoActiveResumeError` (deactivate/delete the seeded résumé row first); happy path returns a `Job.parse`-valid job whose `score` matches the scripted `MATCH_SCORE` fixture; null-description job with a no-`fetchDetail` source throws `EmptyJobDescriptionError`.

- [ ] **Step 3: Route + failing tests.** Mirror `src/app/api/jobs/[id]/route.ts` (UuidParam guard → 404 on malformed). Error map exactly as the Interfaces block. Route tests: malformed id `not-a-uuid` → 404 `NOT_FOUND`; unknown uuid → 404; no-résumé → 409 `CONFLICT`; happy path (doubles) → 200 `Job.parse` succeeds AND a `job_scores` row exists after. Implement, PASS.

- [ ] **Step 4: Contract**: `registerPath` POST `/api/jobs/{id}/evaluate` (200 Job + the 4 error envelopes), `npm run contract`, route-coverage PASS.

- [ ] **Step 5: Full suite**: `npm test` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/score/evaluate.ts src/server/score/evaluate.test.ts src/app/api/jobs/[id]/evaluate src/server/persistence/repos/jobs.ts src/contract/registry.ts contract/openapi.json src/server/persistence/repos/*.test.ts src/server/search/run.ts
git commit -m "feat(api): POST /api/jobs/:id/evaluate — on-demand re-score via scoreJob"
```

---

### Task 7: LIVE verification checkpoint (controller-led — real network, real OpenRouter spend)

**No implementer dispatch — the controller runs this, with real-time judgment.** Budget note: gpt-oss-120b at $0.03/$0.15 per MTok ≈ well under $0.01 per scored job; a full run of both personas + tailor ≈ a few cents. User approved real spend.

- [ ] Step 1: Re-seed the dev DB: `psql "$DATABASE_URL" -c "DELETE FROM job_scores" -c "DELETE FROM jobs" -c "DELETE FROM sources"` then `npm run db:seed` → 13 rows.
- [ ] Step 2: `npm run smoke:real` → expect openrouter (now gpt-oss-120b), postgres, pdf, jobstreet-MY all green. If jobstreet's `MY-Main` siteKey is rejected, capture the live error body, adjust siteKey/params from the response evidence, re-run.
- [ ] Step 3: Start `npm run dev` (real mode). `POST /api/search {"persona":"remote"}` → stream `GET /api/search/:id` SSE → run completes; `GET /api/jobs?persona=remote` returns scored jobs with real legitimacy tiers. Record: jobs found, scored, unscored, cost (`SELECT sum(cost_usd) FROM job_scores`).
- [ ] Step 4: Same for `{"persona":"local"}` → JobStreet MY jobs, Malaysia locations visible.
- [ ] Step 5: `POST /api/jobs/<some-id>/evaluate` → 200, fresh score row.
- [ ] Step 6: `POST /api/tailor {"jobId": <id>}` → poll to `completed` → `finalize` (accept all) → `GET /api/tailor/:id/pdf` → bytes start `%PDF`.
- [ ] Step 7: Write results into the progress ledger. Any breakage → targeted fix tasks (implementer dispatches) before proceeding.

---

### Task 8: Sources page UI (list + toggles) + sidebar entry

**Files:**
- Create: `src/features/sources/client.ts`, `src/app/sources/page.tsx`, `src/caliber-ui/compositions/Sources/SourceList.tsx`, `src/caliber-ui/compositions/Sources/SourceList.stories.tsx`, `src/caliber-ui/compositions/Sources/SourceList.dom.test.tsx`
- Modify: `src/app/AppShell.tsx:25-38` (enable the existing hidden `sources` nav row)
- Modify: `docs/architecture/component-inventory.md` (add SourceList row, same style as the ScanProgress addition)

**Interfaces:**
- Consumes: `Source` entity + endpoints (Task 5); the 13 primitives in `src/caliber-ui/components` (read `src/caliber-ui/components/index.ts` first; compose only — never reinvent); `features/http.ts` fetch wrapper.
- Produces: `listSources(): Promise<Source[]>`, `setSourceEnabled(id: string, enabled: boolean): Promise<Source>` in `features/sources/client.ts`. `SourceList` is presentational: `{ sources: Source[]; busyId?: string | null; onToggle: (id: string, enabled: boolean) => void }`, grouped into two sections — "Remote · global" (persona `remote`|`both`) and "Malaysia · local" (persona `local`|`both`) — each row: name, kind `Tag` (ATS/Board), and a toggle control (use a `Button` variant if no switch primitive exists; pressed state = enabled; `aria-pressed` set).

- [ ] **Step 1: `features/sources/client.ts`** — mirror `features/feed/client.ts` exactly (http wrapper, `Source.parse` on items). No test needed beyond what the existing feature clients have (check if they have tests; mirror).
- [ ] **Step 2: `SourceList` + failing dom test** (jsdom pragma pattern from `ScanProgress.dom.test.tsx`): renders both persona groups; toggling a row calls `onToggle(id, !enabled)`; `busyId` row's control is disabled. Then implement; PASS. Storybook story with a realistic 13-row fixture (ids/names from the Task 2 seeds).
- [ ] **Step 3: `src/app/sources/page.tsx`** — "use client"; load → `listSources()`; optimistic-free toggle: set `busyId`, `setSourceEnabled`, replace row from response, clear `busyId`; error → keep prior state + inline error text with Retry (mirror `feed/page.tsx`'s load/error handling style).
- [ ] **Step 4: AppShell**: add `"sources"` to `ENABLED`, `sources: "/sources"` to `routeFor`, and `if (pathname.startsWith("/sources")) return "sources";` to `activeIdFor`.
- [ ] **Step 5: Update `src/app/page-render.test.tsx`** if it walks routes (read it; add `/sources` if the pattern expects every enabled route — assert it renders the "Sources" heading).
- [ ] **Step 6: `npm test` → PASS; commit**

```bash
git add src/features/sources src/app/sources src/caliber-ui/compositions/Sources src/app/AppShell.tsx src/app/page-render.test.tsx docs/architecture/component-inventory.md
git commit -m "feat(ui): Sources page — per-source enable toggles, sidebar entry"
```

---

### Task 9: Evaluate button on the job detail page

**Files:**
- Modify: `src/caliber-ui/compositions/Detail/JobDetail.tsx` (new optional action), its stories + dom test file (extend)
- Modify: `src/app/jobs/[id]/page.tsx` (wire handler)
- Modify: `src/features/feed/client.ts` (add `evaluateJob`)

**Interfaces:**
- Consumes: `POST /api/jobs/:id/evaluate` (Task 6).
- Produces: `evaluateJob(id: string): Promise<Job>` in `features/feed/client.ts` (http wrapper + `Job.parse`). `JobDetail` gains `onEvaluate?: () => void` and `evaluateStatus?: "idle" | "evaluating" | "error"` — renders a secondary "Re-evaluate" `Button` beside the existing Tailor action ONLY when `onEvaluate` is provided; label switches to "Re-evaluating…" and disables while `evaluating`; a short inline error line when `error` (match the composition's existing error-text idiom).

- [ ] **Step 1: dom test first** (extend JobDetail's existing dom test): button renders when `onEvaluate` given, absent otherwise; click fires; `evaluating` disables. FAIL → implement → PASS.
- [ ] **Step 2: Page wiring**: handler sets `evaluating`, calls `evaluateJob(job.id)`, replaces the page's job state with the response (fresh score/legitimacy render immediately), `error` state on throw. Read the page first and match its existing data-flow (it fetched via `getJob`).
- [ ] **Step 3: Story**: add an `onEvaluate` variant to JobDetail stories.
- [ ] **Step 4: `npm test` → PASS; commit**

```bash
git add src/caliber-ui/compositions/Detail src/app/jobs src/features/feed/client.ts
git commit -m "feat(ui): Re-evaluate action on job detail wired to POST /api/jobs/:id/evaluate"
```

---

### Task 10: ScanProgress fixtures speak the real stage vocabulary

**Files:**
- Modify: `src/caliber-ui/compositions/Feed/ScanProgress.stories.tsx`, `src/caliber-ui/compositions/Feed/ScanProgress.dom.test.tsx`

**Interfaces:** none new. The WIP stories/dom-test use invented stages (`discover`/`extract`/`finalize`) that type-check only because `stage: string`; production sends `sources|fetch|score|legitimacy` with labels from `src/features/search/scanStages.ts` (`initialStages()`): "Discovering postings" / "Reading each posting" / "Scoring fit" / "Filtering ghost jobs".

- [ ] **Step 1:** Replace every fixture stage/label in both files with the four real pairs above (keep test semantics — done/active/pending glyph assertions — intact; just re-key them). Do NOT import from `features/` into the story if the file currently has no such import — inline the literals with a comment `// must mirror features/search/scanStages.ts SCAN_STAGES`.
- [ ] **Step 2:** `npx vitest run src/caliber-ui/compositions/Feed` → PASS. Commit:

```bash
git add src/caliber-ui/compositions/Feed
git commit -m "test(ui): ScanProgress fixtures use the real scan stage vocabulary"
```

---

### Task 11: Playwright E2E harness (native-Postgres adaptation of deferred Task 2.6)

**Files:**
- Create: `playwright.config.ts`, `e2e/globalSetup.ts`, `e2e/feed.spec.ts`
- Modify: `package.json` (devDep `@playwright/test`, script `"test:e2e": "playwright test"`)

**Reference:** `docs/superpowers/plans/2026-07-11-test-automation.md` lines 1183-1270 (Task 2.6) — same intent, but Docker is NOT available here; a native Postgres runs on `localhost:5432`.

**Interfaces:**
- Produces: `npm run test:e2e` boots the app at `http://localhost:3005` in doubles mode against a scratch `caliber_e2e` database and runs `e2e/*.spec.ts`. Task 12's journeys plug into this. In CI (`process.env.CI`), globalSetup uses the provided `DATABASE_URL` as-is (service container) instead of creating a scratch DB.

- [ ] **Step 1:** `npm install -D @playwright/test@1.61.1` (pin to the installed `playwright` version — mismatched versions break). `npx playwright install chromium` (likely a no-op; run anyway).
- [ ] **Step 2: `e2e/globalSetup.ts`:**

```ts
import { execSync } from "node:child_process";

// Local: scratch DB on the native Postgres. CI: the workflow's service
// container provides DATABASE_URL — use it as-is (drop/create is the
// container's job there; it starts empty).
export const E2E_DB_URL = process.env.CI
  ? (process.env.DATABASE_URL as string)
  : "postgresql://localhost:5432/caliber_e2e";

export default async function globalSetup() {
  if (!process.env.CI) {
    execSync(`psql -d postgres -c "DROP DATABASE IF EXISTS caliber_e2e" -c "CREATE DATABASE caliber_e2e"`, { stdio: "inherit" });
  }
  const env = { ...process.env, DATABASE_URL: E2E_DB_URL, CALIBER_TEST_DOUBLES: "1" };
  execSync("npm run db:migrate", { stdio: "inherit", env });
  execSync("npm run db:seed:test", { stdio: "inherit", env });
}
```

(If `process.env.CI` is set but `DATABASE_URL` is not, throw — fail loud.)

- [ ] **Step 3: `playwright.config.ts`:**

```ts
import { defineConfig } from "@playwright/test";
import { E2E_DB_URL } from "./e2e/globalSetup";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/globalSetup.ts",
  timeout: 60_000,
  use: { baseURL: "http://localhost:3005", trace: "on-first-retry" },
  webServer: {
    command: "npx next dev -p 3005",
    url: "http://localhost:3005/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: { DATABASE_URL: E2E_DB_URL, CALIBER_TEST_DOUBLES: "1", OPENROUTER_API_KEY: "unused-in-doubles-mode" },
  },
});
```

(Port 3005 avoids clashing with any running dev server. Verify `/api/health` returns 200 with `{mode:"doubles"}` — it does per the health-mode task in the previous plan.)

- [ ] **Step 4: First journey `e2e/feed.spec.ts`:**

```ts
import { expect, test } from "@playwright/test";

test("feed renders with persona toggle and sidebar", async ({ page }) => {
  await page.goto("/feed");
  await expect(page.getByText("Remote · global")).toBeVisible();
  await expect(page.getByText("Matches")).toBeVisible();
});
```

- [ ] **Step 5:** Run `npm run test:e2e` → 1 passed. Ensure `npm test` (vitest) does NOT pick up `e2e/**` (vitest include is `src/**` — verify). Commit:

```bash
git add playwright.config.ts e2e package.json package-lock.json
git commit -m "test(e2e): Playwright harness — native-Postgres scratch DB, doubles-mode webServer"
```

---

### Task 12: E2E journeys — the full click-through

**Files:**
- Create: `e2e/resume-scan-feed.spec.ts`, `e2e/detail-evaluate-applied.spec.ts`, `e2e/tailor.spec.ts`, `e2e/sources.spec.ts`

**Reference:** journey briefs in `docs/superpowers/plans/2026-07-11-test-automation.md` lines 1271-1360 (Tasks 2.7-2.9) — adapt selectors to the CURRENT pages (they predate the ScanProgress WIP). Doubles mode is deterministic: fixture connector yields one posting per enabled source; mock LLM returns the scripted Jane-Doe fixtures (`src/lib/llm/scripted-fixtures.ts`).

**Journeys (each `test(...)` names the flow it pins):**

- [ ] **Step 1: `resume-scan-feed.spec.ts`** — paste-text résumé ingest (use the ≥100-char sample text from the old plan's Task 2.7 brief, or any 150-char engineering blurb) → expect navigation to `/feed` (scan handoff) → ScanProgress overlay appears → wait for its done-state ("View your matches" button) → dismiss → at least one `JobRow` visible with a score badge and a legitimacy tag.
- [ ] **Step 2: `detail-evaluate-applied.spec.ts`** — seed path: run a scan first via the UI "Scan now" button (or reuse the state from a fresh ingest — each spec must be independent; simplest is API-bootstrap: `request.post("/api/resume", {data:{text: SAMPLE}})` then `request.post("/api/search", {data:{persona:"remote"}})` and poll `GET /api/jobs` until non-empty). Then: open `/feed` → click the first job row → job detail page → click "Re-evaluate" → button shows "Re-evaluating…" then returns to idle with a score still visible → click the mark-applied action → navigate to `/tracker` → the application row exists.
- [ ] **Step 3: `tailor.spec.ts`** — API-bootstrap as above → open the job detail → "Tailor" → tailor page: Generate → review state shows diff cards → accept-all → Save → saved state. Then Export PDF: `request.get` the pdf URL → status 200, `content-type: application/pdf`, body starts `%PDF` (real Chromium render — doubles mode only mocks the LLM, not the PDF; if Chromium is genuinely missing in this env the step must FAIL loudly, not be skipped silently).
- [ ] **Step 4: `sources.spec.ts`** — open `/sources` via the sidebar → both persona groups visible → toggle the first remote source off → reload → still off (persisted) → toggle back on. (Seed-test provides the 4 canonical sources.)
- [ ] **Step 5:** `npm run test:e2e` → all specs pass, twice in a row (flake check). `npm test` still green. Commit:

```bash
git add e2e
git commit -m "test(e2e): journeys — ingest→scan→feed, detail/evaluate/applied, tailor+pdf, sources toggles"
```

---

### Task 13: Enable the CI e2e job

**Files:**
- Modify: `.github/workflows/ci.yml` (e2e job: replace `if: ${{ false }}` with a real run)

**Interfaces:** consumes Task 11's CI-aware globalSetup (`process.env.CI` → use provided `DATABASE_URL`).

- [ ] **Step 1:** Read the existing inert job. Update it to: postgres:16 service (already written), env `DATABASE_URL` + `CALIBER_TEST_DOUBLES=1` + `CI=true`, steps `npm ci` → `npx playwright install --with-deps chromium` → `npm run test:e2e` (migrate+seed happen inside globalSetup now — remove any duplicated migrate/seed steps the inert job carried, or keep them if globalSetup would double-run them harmlessly; prefer single-source in globalSetup). Remove the `if: ${{ false }}` and its "deferred" comment.
- [ ] **Step 2:** Validate YAML locally: `npx yaml-lint .github/workflows/ci.yml 2>/dev/null || python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))"` → no error.
- [ ] **Step 3:** Commit:

```bash
git add .github/workflows/ci.yml
git commit -m "ci: enable e2e job — Playwright journeys against service-container Postgres"
```

---

### Task 14: Final live pass + whole-branch review

**Controller-led.**

- [ ] Step 1: `npm run check` (typecheck + vitest + contract:check + build) → exit 0.
- [ ] Step 2: `npm run test:e2e` → green.
- [ ] Step 3: Re-run the Task 7 live loop once end-to-end on the finished branch (scan both personas → evaluate button via UI on the real dev server → tailor+PDF) — record costs and results in the ledger.
- [ ] Step 4: Dispatch the final whole-branch code review (most capable model) per superpowers:requesting-code-review with `scripts/review-package MERGE_BASE HEAD`; fix wave as one subagent if findings; then superpowers:finishing-a-development-branch.

---

## Self-Review Notes

- **Spec coverage vs the user's ask:** scan real remote sources ✅ (T2/T3/T7); Malaysia-local only fetches MY jobs ✅ (T2 JobStreet MY config + persona scoping already in `listEnabledByPersona`); see all sources + toggle ✅ (T5/T8); see results after scan ✅ (WIP ScanProgress + feed, verified live in T7); evaluate with the template via OpenRouter gpt-oss-120b ✅ (T1 + T7; template = existing `config/templates/match-score.md`, donor-derived); Evaluate button ✅ (T6/T9); Tailor CV button already exists on job detail — verified live in T7 (tailor was fully built in Phase B/C); Playwright coverage ✅ (T11-T13). "Modal popup" for results: job detail is an existing full page (`/jobs/[id]`), which the click-through already opens — treated as satisfying "see the details"; building a modal would duplicate an existing screen (flag to user in the final report, not built).
- **Type consistency:** `Source` (T5) is consumed by T8's client/UI; `evaluateJob` name used in both T6 (server) and T9 (`features/feed/client.ts` — different layer, same wire call); `ensureDescription(job, source)` defined T4, reused T6.
- **Known live risks (deliberately verified in T7, not hidden):** Ashby `descriptionHtml` field name; JobStreet `MY-Main` siteKey; JobStreet detail-page anti-bot walls; SEEK API shape drift. Each has a fail-loud path and a smoke probe.
