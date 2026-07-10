# Caliber Phase B — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Caliber backend — Next.js 15 App Router around the existing `src/`, Drizzle persistence, an OpenRouter LLM client, source connectors, the `server/*` services, and the API routes per `api-contract.md` — then wire the (already injectable) MVP components to real handlers so the F1–F6 spine runs end-to-end.

**Architecture:** Strict three-layer: UI → `features/*` (typed fetch wrappers, feed assembly, status-map) → `server/*` (the ONLY layer that touches DB or LLM). Zod schemas in `src/types` are the single source of truth; every route does `Schema.parse` at the boundary and fails loud. LLM access is OpenRouter-only, template-guided, cheapest-viable-per-task. Search/tailor use one run pattern (202 + SSE/poll on a `GET :id`).

**Tech Stack:** Next.js 15 (App Router) · React 19 · TypeScript 5.6.3 · Drizzle ORM (Postgres prod / SQLite dev) · OpenRouter (OpenAI-compatible SDK) · Playwright-Chromium (in-process PDF) · Vitest (unit/integration) · `@asteasolutions/zod-to-openapi` + Scalar (docs) · Storybook 8 (Vite, coexisting).

## Global Constraints

Copied verbatim from the specs; **every task's requirements implicitly include this section.**

- **Layering (spec §3):** UI → `features/*` → `server/*`. Only `server/*` may import the DB client or the LLM client. A `features/*` or component file importing `server/persistence` or `lib/llm` is a plan violation.
- **Contract is code:** Zod schemas in `src/types` are the single source of truth → OpenAPI → docs. **Do not add fields absent from the contract without updating `src/types` + `api-contract.md` first.** Where `component-inventory.md` §2/§3 sketches differ from `src/types` (e.g. `ApplicationQuestion.kind`, `TailorChange`), **`src/types` wins** — the inventory shapes are a superseded draft.
- **Fail loud (fintech rule):** validate at system boundaries only (`Schema.parse`); internal callers are trusted. No fallback defaults, no silent `0`/`""`/`unknown`. Missing required value → throw a specific error, never default.
- **Boundary rule everywhere:** `Schema.parse(body)` at the route handler; `ZodError` → **422** `VALIDATION_ERROR` with `issues` in `details`. No defaults injected.
- **LLM = OpenRouter only:** OpenAI-compatible client, `baseURL https://openrouter.ai/api/v1`, `OPENROUTER_API_KEY`. Cheapest viable model per task, template-guided via `config/models.yml`. **NOT** Anthropic direct — do **not** use the `claude-api` skill or `@anthropic-ai/*`. No `claude -p` subprocesses, no CLI-subprocess workers.
- **No donor file-plane / job engine:** rebuild donor logic clean. No markdown tracker parsing, no TSV scan state, no LaTeX. Donor corrections: **no `scan_jobs` table** (build fresh `jobs`), **no `verdict/verdict.ts`** (legitimacy lives inside `server/score`), donor **rejects `.docx`** (add `mammoth`), **LaTeX dropped**, eval **Stage 3 Deep cut** (Stage 1 JD-facts + Stage 2 score+legitimacy only).
- **DB (revised — see B1):** **Postgres everywhere** (`drizzle-orm/pg-core`), tests run on **PGlite** (in-memory Postgres). This supersedes the docs' "Postgres prod / SQLite dev" line: since a real `DATABASE_URL` is provided and Drizzle has no cross-dialect schema (pg-core vs sqlite-core are separate constructors), one PG schema + PGlite for tests removes the portability-layer problem entirely. **Operator veto point** — if SQLite-dev is required, B1 switches to dual schema generated from a shared column-spec (more code, drift risk).
- **TypeScript pinned to 5.6.3** (a TS7-preview had broken `tsc`). `@/*` → `./src/*`.
- **Storybook coexists:** `npm run storybook` / `npm run build-storybook` must stay green throughout. Storybook uses Vite independently of Next.
- **Cost cap (Gate #5):** per-run score cap (~30 jobs) + a daily cap env var; `costUsd` recorded on every `job_scores` / `application_answers` / `tailored_resumes` row from day one.
- **Résumé storage:** original bytes → `data/uploads/` (host disk), path in DB; text + structured in DB. No S3.
- **Search execution:** inline async in-process; in-memory run registry keyed by `search_runs.id`; hard runtime cap; on boot mark any `running` run stale.
- **Progress:** SSE (`Accept: text/event-stream`) with JSON-snapshot polling fallback on the same `GET :id` route.
- **Auth:** none in v1 (single-operator); protect at the network layer. Record as a v1 constraint in OpenAPI.
- **Env target:** user is providing real `OPENROUTER_API_KEY` and `DATABASE_URL`; build against real OpenRouter + Postgres, but all tests run against SQLite + a mocked LLM (no network, no cost, in CI).

---

## Slice map & dependency order

Phase B is decomposed into 11 independently-shippable slices. Each ends with a testable deliverable and a commit. Arrows = hard dependencies.

```
B0 scaffold ─┬─> B1 persistence ─┬─> B4 resume (F1)
             │                    ├─> B5 search+connectors (F2 discovery) ─> B6 score (F2 scoring)
             ├─> B2 lib/llm ──────┤
             └─> B3 contract/docs │     B6 ─> B7 apply-assistant (F4)
                                  │     B6 ─> B8 tailor (F6)
                                  └─> B9 tracker (F5)
B4…B9 ─> B10 wiring + e2e click-through
```

- **B0** Next 15 scaffold coexisting with Storybook (+ `/api/health`).
- **B1** Drizzle client + 8-table schema + repos + migrations (SQLite dev / PG prod).
- **B2** `lib/llm`: OpenRouter client + `config/models.yml` + template registry + cost accounting.
- **B3** `src/contract`: zod-to-openapi registry + `npm run contract` → `openapi.json` + Scalar `/api/docs`.
- **B4** `server/resume` F1 ingest + `POST`/`GET /api/resume`.
- **B5** source connectors + `server/search` F2 discovery + `POST`/`GET /api/search` (SSE) + jobs upsert.
- **B6** `server/score` F2 scoring + 5-tier legitimacy + `features/feed` Job assembly + `GET /api/jobs` + `GET /api/jobs/:id`.
- **B7** `server/apply-assistant` F4 + `/api/apply/questions` + `/api/apply/answers` + `PATCH /api/apply/answers/:id`.
- **B8** `server/tailor` F6 + `lib/pdf` + `/api/tailor` (SSE) + `finalize` + `pdf`.
- **B9** `server/tracker` F5 + `/api/applications` (POST/GET/PATCH) + `features/applied/status-map.ts`.
- **B10** `features/*` fetch wrappers, wire injectable component props to real handlers, drop fixtures-in-prod, F3 apply-out `<a>`, full click-through verified with `/run`.

**Granularity gradient (read this).** B0–B3 (the substrate every later slice imports) are specified below in full bite-sized TDD detail. B4–B10 are specified at **task granularity with locked interfaces (exact signatures) + testable deliverable + commit points**. Each B4–B10 slice is expanded into full micro-step TDD detail *just before it is executed* (subagent-driven-development), so its steps reflect the interfaces that upstream slices actually produced rather than planning fiction. The **Locked interfaces** section below is the cross-slice contract that keeps signatures from drifting during that JIT expansion.

---

## Locked interfaces (cross-slice contract)

These signatures are fixed here so slices authored/executed independently cannot drift. A later slice consuming one of these must use it verbatim.

```ts
// src/server/persistence/db.ts  (Postgres everywhere; PGlite in tests — see B1)
export function getDb(): DrizzleClient;            // singleton over pg-core schema; driver from DATABASE_URL
// src/server/persistence/repos/*.ts — one repo object per table, e.g.:
export const resumesRepo: {
  insertReplacingActive(row: NewResume): Promise<ResumeRow>;   // v1 holds exactly one active résumé
  getActive(): Promise<ResumeRow | null>;
};
export const jobsRepo: {
  upsertByDedupeKey(row: NewJob): Promise<JobRow>;
  listScored(q: JobsQuery): Promise<{ items: JobJoinScore[]; nextCursor: string | null }>;
  getById(id: string): Promise<JobJoinScore | null>;
};
export const applicationsRepo: {
  insertUniqueByJob(row: NewApplication): Promise<AppRow>;     // 409 on jobId conflict
  listJoined(q: AppQuery): Promise<{ items: AppJoinJobScore[]; nextCursor: string | null }>;  // applications ⋈ jobs ⋈ job_scores → role/company/meta/score
  getJoined(id: string): Promise<AppJoinJobScore | null>;
  patch(id: string, p: Partial<AppPatch>): Promise<AppRow | null>;
};
// (searchRunsRepo, jobScoresRepo, applicationAnswersRepo, tailoredResumesRepo, sourcesRepo — same pattern)

// src/lib/llm/client.ts  — generic transport ONLY; no task-specific escalation logic (that lives in server/score)
export interface LlmClient {
  complete<T>(args: {
    task: TaskName;                    // key into config/models.yml (selects the base model)
    modelOverride?: string;            // caller (e.g. server/score) passes escalateTo model on re-run
    messages: LlmMessage[];
    responseSchema: z.ZodType<T>;      // Zod schema; client derives JSON Schema for response_format AND validates the reply
    signal?: AbortSignal;
  }): Promise<{ data: T; model: string; costUsd: number }>;   // data already Zod-validated
}
export type TaskName = 'resume-extract'|'jd-extract'|'match-score'|'question-extract'|'question-answer'|'tailor';
export function getLlm(): LlmClient;   // real OpenRouter in prod; makeMockLlm() injected in tests

// src/server/search/connector.ts  (verbatim from system-architecture §3)
export interface SourceConnector {
  id: string; kind: 'ats'|'board'; persona: 'remote'|'local'|'both';
  discover(ctx: { targets: RoleTarget[]; since: Date; signal: AbortSignal;
                  onProgress: (e: ProgressEvent) => void }): AsyncIterable<RawPosting>;
  fetchDetail?(p: RawPosting): Promise<{ description: string; applyUrl?: string }>;
  extractQuestions?(job: Job): Promise<FormField[] | null>;   // F4 tier 1/2
}
export interface RawPosting {
  sourceId: string; externalId?: string; url: string; title: string;
  company: string; location?: string; description?: string; postedAt?: string; salaryRaw?: string;
}
export interface RoleTarget {              // derived in B5 from the active résumé (titles + skills) per persona preset
  titles: string[]; keywords: string[]; locationsPreferred?: string[]; persona: 'remote'|'local';
}

// src/server/score/index.ts — scoreJob OWNS escalation (re-runs llm.complete with modelOverride when shouldEscalate)
export function scoreJob(args: { job: JobRow; resume: ResumeRow; llm: LlmClient })
  : Promise<JobScoreRow>;              // JdFacts → EvalScores(+5-tier legitimacy) → row

// src/features/feed/assemble.ts
export function assembleJob(job: JobJoinScore): Job;
// applyUrl resolution (documented, NOT a silent fallback): jobs.applyUrl is nullable (resolved redirect);
// assembleJob sets Job.applyUrl = row.applyUrl ?? row.url. This resolution rule is added to
// api-contract.md's applyUrl comment so it is contract, not an ad-hoc default. row.url is never null.

// src/features/applied/status-map.ts — takes the outcome, not stage alone (verified/neutral unreachable from stage)
export type AppOutcome = 'open'|'offer'|'closed';
export function foldStatus(stage: 0|1|2|3, outcome: AppOutcome)
  : { statusLabel: string; statusTone: 'good'|'verified'|'neutral' };   // open→good, offer→verified, closed→neutral

// Run registry (search + tailor share the pattern)
// src/server/runs/registry.ts
export const runRegistry: {
  create(kind: 'search'|'tailor', id: string): RunHandle;
  get(id: string): RunHandle | null;
  markStaleRunningOnBoot(): Promise<void>;
};   // RunHandle exposes an async event stream consumed by the SSE route
```

---

## B0 — Next.js 15 scaffold coexisting with Storybook

**Files:**
- Create: `next.config.mjs`, `next-env.d.ts`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/api/health/route.ts`
- Modify: `tsconfig.json` (reconcile with Next), `package.json` (scripts + deps), `.gitignore` (add `.next`, `data/uploads`)
- Test: `src/app/api/health/route.test.ts`

**Interfaces:**
- Produces: a running Next dev server, `GET /api/health` → `{ ok: true }`, `@/*` alias intact for both Next and Storybook.

- [ ] **Step 1: Install Next + test runner (pin TS)**

```bash
npm i next@15 && npm i -D vitest@2 @vitejs/plugin-react
npm i -D typescript@5.6.3   # re-pin; do not let Next bump it
```

- [ ] **Step 2: Write the failing health-route test**

`src/app/api/health/route.test.ts`
```ts
import { describe, it, expect } from 'vitest';
import { GET } from './route';

describe('GET /api/health', () => {
  it('returns ok', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 3: Run it — verify it fails**

Run: `npx vitest run src/app/api/health/route.test.ts`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 4: Add `vitest.config.ts` and the minimal app**

`vitest.config.ts`
```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  test: { environment: 'node', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] },
});
```

`src/app/api/health/route.ts`
```ts
import { NextResponse } from 'next/server';
export function GET() {
  return NextResponse.json({ ok: true });
}
```

`src/app/layout.tsx`
```tsx
import '@/caliber-ui/styles/tokens.css';
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="en"><body>{children}</body></html>);
}
```

`src/app/page.tsx`
```tsx
export default function Home() {
  return <main style={{ padding: 24 }}>Caliber — backend up. Storybook is the gallery.</main>;
}
```

- [ ] **Step 5: Reconcile `tsconfig.json` for Next + Storybook**

Next requires `jsx: "preserve"`, `moduleResolution: "bundler"`, `plugins: [{ name: "next" }]`, `incremental`, and the `.next/types` include. Vite/Storybook transform JSX via esbuild regardless of the tsconfig `jsx` value, so `preserve` is safe for both. Set:
```jsonc
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "noEmit": true,
    "jsx": "preserve",
    "strict": true,
    "skipLibCheck": true,
    "incremental": true,
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] },
    "plugins": [{ "name": "next" }]
  },
  "include": ["src", ".storybook", "next-env.d.ts", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```
Note: remove `allowImportingTsExtensions` (Next rejects it). Verify no story imports use explicit `.ts`/`.tsx` extensions — grep first; fix any that do.

- [ ] **Step 6: `next.config.mjs` + package scripts**

`next.config.mjs`
```js
/** @type {import('next').NextConfig} */
export default { reactStrictMode: true };
```
Add to `package.json` scripts: `"dev": "next dev"`, `"build": "next build"`, `"start": "next start"`, `"test": "vitest run"`, `"typecheck": "tsc --noEmit"`. Add `.next` and `data/uploads` to `.gitignore`.

- [ ] **Step 7: Run health test + typecheck + storybook build — all green**

Run: `npx vitest run src/app/api/health/route.test.ts && npm run typecheck && npm run build-storybook`
Expected: test PASS, `tsc` clean, Storybook builds. Then `npm run dev` and confirm `curl localhost:3000/api/health` → `{"ok":true}`.

- [ ] **Step 8: Record `/api/health` in the contract (resolves finding 10)**

Add a one-line row to `api-contract.md`'s endpoint table (`GET /api/health` — liveness, unauthenticated) so the route obeys the "no endpoint without updating the contract" rule. No `src/types` change needed (response is `{ok:true}`).

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat(b0): Next 15 App Router scaffold coexisting with Storybook + /api/health"
```

---

## B1 — Persistence (Drizzle: client, schema, repos, migrations)

**DB mechanism (resolves review finding 1).** Postgres everywhere via `drizzle-orm/pg-core`; tests run on **PGlite** (`@electric-sql/pglite` — in-memory Postgres, same SQL dialect). One schema, one migration set, one `drizzle.config.ts` (`dialect: 'postgresql'`). No cross-dialect abstraction (Drizzle doesn't support it). Operator veto → dual schema from a shared column-spec instead.

**Column-binding rule (resolves review finding 2).** Columns bind to `system-architecture.md §1` **except where §1 contradicts the frozen `src/types` — there `src/types` wins.** The four known conflicts to reconcile in `schema.ts`:
1. `search_runs.status` — use `RunStatus = queued|running|completed|failed` (not §1's `queued|running|done|error`).
2. `tailored_resumes.status` — use `RunStatus`; add an explicit `finalizedAt timestamp?` column so `GET /api/tailor/:id/pdf` can 409 `RUN_NOT_READY` until finalize (not §1's `draft|approved`).
3. `tailored_resumes` diff column — store the `src/types` `diff [{section, op: add|remove|modify, before?, after?, reason}]` shape (not §1's `changes [{current,proposed,why}]`).
4. `application_answers` — add a `resumeId` FK and store answers in the `ApplicationAnswer` shape (`{questionId, prompt, answer, grounding[]}`) so `grounding` has a storage home (not §1's donor `FormField&{answer,needs_candidate_confirmation}`).

**Files:**
- Create: `src/server/persistence/db.ts`, `src/server/persistence/schema.ts`, `src/server/persistence/seed.ts` (sources rows), `src/server/persistence/repos/{resumes,jobs,searchRuns,jobScores,applications,applicationAnswers,tailoredResumes,sources}.ts`, `drizzle.config.ts`, `.env.example`, `src/server/persistence/test-db.ts` (PGlite harness)
- Modify: `package.json` (drizzle + pglite deps + `db:*` scripts)
- Test: `src/server/persistence/repos/*.test.ts` (PGlite)

**Interfaces:**
- Consumes: nothing (foundation).
- Produces: the `getDb()` + `*Repo` surface in **Locked interfaces** (incl. `applicationsRepo.listJoined`/`getJoined`). 8 tables: `sources, resumes, search_runs, jobs, job_scores, applications, application_answers, tailored_resumes`. JSON blobs (`structured`, `breakdown`, `legitimacy`, `fields`, `diff`, `grounding`) via pg `jsonb`.

**Tasks (expand to micro-steps at execution):**
- [ ] Install `drizzle-orm`, `drizzle-kit`, `postgres` (prod driver), `@electric-sql/pglite` (tests). Add `db:generate`/`db:migrate` scripts (`dialect: postgresql`).
- [ ] `db.ts`: `getDb()` singleton over the pg-core `schema`, driver from `DATABASE_URL`. `test-db.ts`: spin a PGlite instance, run migrations, return a Drizzle client — the harness every repo test uses.
- [ ] `schema.ts`: all 8 tables per §1 **with the four `src/types`-wins reconciliations above**. Constraints: `dedupeKey` UNIQUE on `jobs`; `(jobId,resumeId,policyVersion)` UNIQUE on `job_scores`; `jobId` UNIQUE on `applications`. **Fail loud:** no column defaults that mask missing data.
- [ ] `seed.ts` (resolves finding 8): insert `sources` rows for `greenhouse|lever|ashby|jobstreet` (id, kind, persona, enabled, `config` slugs) so real runs have targets — without it every real run scans nothing while mocked tests stay green. Run via a `db:seed` script.
- [ ] Repos: one object per table. `resumesRepo.insertReplacingActive` = atomic single-active-résumé supersede. `jobsRepo.upsertByDedupeKey` = dedupe-on-conflict. `jobsRepo.listScored` = `GET /api/jobs` cursor+filter query (persona/tier/minScore/isNew/remote/q/cursor/limit). `applicationsRepo.listJoined`/`getJoined` = applications ⋈ jobs ⋈ job_scores (supplies `role/company/meta/score` the wire `Application` needs — resolves finding 7).
- [ ] TDD: per repo, PGlite migrate + round-trip (insert → read → shape asserted). Supersede, upsert-dedupe, unique-conflict, and the applications join each get a test.

**Deliverable:** `npm run db:migrate` + `db:seed` succeed on Postgres; every repo test green on PGlite. Row types exported for services.
**Commit:** `feat(b1): Drizzle schema + repos + migrations (SQLite dev / PG prod)`

---

## B2 — `lib/llm` (OpenRouter client, model config, template registry)

**Files:**
- Create: `src/lib/llm/client.ts`, `src/lib/llm/models.ts` (loads `config/models.yml`), `src/lib/llm/templates.ts` (template registry + `policyVersion` hash), `config/models.yml`, `config/templates/*.md` (one per task), `src/lib/llm/mock.ts` (injectable test double)
- Modify: `package.json` (`openai`, `yaml` deps)
- Test: `src/lib/llm/client.test.ts`, `src/lib/llm/templates.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `getLlm(): LlmClient` + `LlmClient.complete<T>` from **Locked interfaces**; `TaskName` union; `policyVersion(task): string` (template-file hash, seeds score-cache invalidation per §6).

**Tasks:**
- [ ] Install `openai` (used purely as the OpenAI-compatible transport against `baseURL https://openrouter.ai/api/v1`, `apiKey: OPENROUTER_API_KEY`) + `yaml`.
- [ ] `models.ts`: parse `config/models.yml` mapping each `TaskName` → `{ model, escalateTo?, maxTokens, temperature }`. `resume-extract`/`jd-extract`/`match-score` = cheapest; `match-score` has `escalateTo` (consumed by `server/score`, not the client); `question-answer` = mid; `tailor` = strong. Fail loud on unknown task. Expose `escalateModel(task)` so `server/score` can look up the override.
- [ ] `templates.ts`: load `config/templates/<task>.md`, expose `render(task, vars)` (fixed block order, candidate/résumé block **last** for prompt caching, per donor `eval/prompts.ts`) and `policyVersion(task)` = content hash.
- [ ] `client.ts`: `complete<T>` takes a Zod `responseSchema`, derives JSON Schema from it (via `zod-to-json-schema` or zod 4's native `.toJSONSchema`) for `response_format: { type: 'json_schema', json_schema }`, then **Zod-validates the reply** and returns `{ data, model, costUsd }` (cost = usage × per-model price). Base model comes from `task`; an optional `modelOverride` lets the caller re-run on a stronger model. **Escalation logic is NOT here** (resolves finding 3) — `server/score` decides `shouldEscalate` and calls `complete` again with `modelOverride: escalateTo`; the generic client stays task-agnostic. Transport failure → throw (caller surfaces `502 UPSTREAM_LLM_ERROR`).
- [ ] `mock.ts`: `makeMockLlm(scripted)` returning canned `{data,model,costUsd}` per task — the test double every service test injects. **No network in tests.**
- [ ] TDD: client test drives a stubbed `fetch`/OpenAI transport (assert baseURL, json_schema wiring, cost math, escalation trigger); templates test asserts stable `policyVersion` + block order.

**Deliverable:** client unit-tested with a mocked transport (zero network); a manual smoke script hits real OpenRouter behind the user's key (documented, not in CI).
**Commit:** `feat(b2): OpenRouter LLM client + models.yml + template registry`

---

## B3 — Contract module (zod-to-openapi + Scalar docs)

**Files:**
- Create: `src/contract/registry.ts`, `src/contract/generate.ts`, `contract/openapi.json` (generated, committed), `src/app/api/docs/route.ts` (Scalar page)
- Modify: `package.json` (`@asteasolutions/zod-to-openapi` dep + `"contract": "tsx src/contract/generate.ts"` script), `src/types/index.ts` (add `.openapi()` metadata where useful — no shape changes)
- Test: `src/contract/registry.test.ts`

**Interfaces:**
- Consumes: `src/types/*`.
- Produces: `contract/openapi.json`; `/api/docs` HTML. Registry grows as each later slice adds its route(s) — B3 seeds it with the entity schemas + `/api/health`.

**Tasks:**
- [ ] Install `@asteasolutions/zod-to-openapi` + `tsx`. **Pin the Zod-4-compatible major** (resolves finding 11): `zod ^4.4.3` is set, and zod-to-openapi ≤v7 peer-depends on Zod v3 — verify/select a v7+ release with Zod-4 support (or the maintained fork) at install; a mismatch fails loud at generate. Record the chosen version.
- [ ] `registry.ts`: register every `src/types` schema and (initially) `/api/health`; both JSON and `text/event-stream` documented on the run GETs (added when B5/B8 land). Record "auth: none, v1 constraint" in the OpenAPI info.
- [ ] `generate.ts`: emit `contract/openapi.json`; `npm run contract` writes it; PRs diff it.
- [ ] `/api/docs/route.ts`: serve a Scalar page reading the committed `openapi.json`.
- [ ] TDD: registry test asserts the doc generates, is valid OpenAPI 3.1, and includes each frozen entity.

**Deliverable:** `npm run contract` emits committed `openapi.json`; `/api/docs` renders in `next dev`.
**Commit:** `feat(b3): Zod→OpenAPI contract registry + Scalar /api/docs`

---

## B4 — `server/resume` (F1 ingest) + `/api/resume`

**Files:** `src/server/resume/{ingest,extract-text,atsScore}.ts`, `src/lib/pdf-text.ts` (lift donor `extractPdfText`, unpdf), `src/app/api/resume/route.ts`, tests.

**Interfaces:**
- Consumes: `resumesRepo` (B1), `getLlm` (B2), `Resume` (`src/types`).
- Produces: `ingestResume(input: {file?: {bytes: Buffer; mime: string}; text?: string}) : Promise<Resume>`; `POST /api/resume`, `GET /api/resume`.

**Tasks:**
- [ ] `extract-text.ts`: PDF via `extractPdfText` (unpdf, text-layer only — scanned PDF throws → surfaces `502 PARSE_FAILED` with paste prompt); DOCX via **`mammoth`** (donor rejects docx — this is net-new); `text` passthrough. Route MIME → extractor; unknown mime → 422.
- [ ] LLM structuring: `resume-extract` template (json_schema = donor `ResumeStore`), then derive the frozen `Resume` **view** (headline/location from contact lines, skills flattened) per §1 reconciliation. Donor shape stored in `resumes.structured`; frozen `Resume` returned at the boundary. **Never persist a partial résumé** — extraction failure throws before insert.
- [ ] `atsScore.ts`: heuristic 0–100 (donor-informed). Deterministic, unit-tested.
- [ ] `ingest.ts`: extract-text → `resume-extract` → view-derive → `resumesRepo.insertReplacingActive` (atomic supersede) → return `Resume`. Store original bytes to `data/uploads/` (path in DB, `sourceKind`).
- [ ] Route: multipart (`file` ≤10MB → 413 over) or JSON `{text: min(100)}`; `POST` → `200 Resume`; `GET` → `200 Resume` | `404`. Register in B3 registry.
- [ ] TDD (mocked LLM): pdf/docx/paste happy paths; scanned-PDF → `PARSE_FAILED`; empty text → 422; oversize → 413; supersede replaces prior active.

**Deliverable:** upload a fixture PDF via `next dev` → structured `Resume` persisted; tests green.
**Commit:** `feat(b4): resume ingest (F1) + /api/resume`

---

## B5 — Source connectors + `server/search` (F2 discovery) + `/api/search`

**Files:** `src/server/search/{connector.ts,registry.ts,run.ts,dedupe.ts,roleMatch.ts}`, `src/server/search/connectors/{greenhouse,lever,ashby,jobstreet}.ts`, `src/server/runs/registry.ts`, `src/app/api/search/route.ts`, `src/app/api/search/[id]/route.ts` (SSE+poll), tests.

**Interfaces:**
- Consumes: `sourcesRepo`, `jobsRepo`, `searchRunsRepo` (B1); `Persona`, `SearchRun`, `Progress`, `SseEvent` (`src/types` / api-contract §4).
- Produces: `SourceConnector`, `RawPosting`, `RoleTarget` (Locked interfaces); `runRegistry`; `startSearch({persona, sources?, resumeId}) : SearchRun`.

**Tasks:**
- [ ] `connector.ts`: the `SourceConnector` interface verbatim (§3).
- [ ] `roleMatch.ts`: port donor `roleFuzzyMatch` (≥2 shared tokens, ≥1 non-baseline, Jaccard ≥0.6) to TS — free pre-filter. Pure, unit-tested.
- [ ] `dedupe.ts`: URL-normalize → `dedupeKey`; secondary `(companySlug, roleTokens-hash, location)` match; ATS beats board for canonical `jobs.url`, board URL → `aliases`. Unit-tested with collision fixtures.
- [ ] Connectors: `greenhouse` (`boards-api.greenhouse.io/v1/boards/{slug}/jobs` → `absolute_url`), `lever` (`api.lever.co/v0/postings/{slug}` → `hostedUrl`), `ashby` (donor patterns) — each an `AsyncIterable<RawPosting>` over stubbed HTTP in tests. **`jobstreet` net-new** (public listing JSON/HTML parse, no login) — built first among MY boards, degrades gracefully behind the interface (its failure → `stats.perSource` error, run continues).
- [ ] `roleMatch.ts` also derives `RoleTarget` (resolves finding 14) from the active résumé — `titles` from `experience[].title` + `headline`, `keywords` from `skills`, `persona` from the run — feeding each connector's `discover(ctx.targets)`.
- [ ] `run.ts`: fan out over `sources WHERE persona IN (active,'both') AND enabled` with `p-limit` (concurrency 5–10), per-connector timeout, partial-failure tolerated into `stats.perSource`; upsert via `jobsRepo.upsertByDedupeKey`; `roleFuzzyMatch` pre-filter; emit **`progress` events only** to the run handle (the `job` SSE event requires a scored `Job`, which does not exist until B6 — resolves finding 5). Hard runtime cap. **No `.mjs` subprocess** — typed in-process connectors only.
- [ ] `runs/registry.ts`: in-memory registry keyed by run id; `markStaleRunningOnBoot()`; async event stream for SSE.
- [ ] `SearchRun` assembly (resolves finding 9): map `search_runs` → wire `SearchRun`. Define **`stats.worth`** = count of scored jobs with `verdict ∈ {Apply, Consider}` (populated in B6; 0 during discovery-only). `stats = {scanned, worth, ghosts}` (§ src/types); table's `matched`/`scored`/`perSource` stay internal.
- [ ] Routes: `POST /api/search` — `{persona, sources?}` (empty `sources` array → 422; omitted → full set), `409` if active run for persona or no résumé → `202 SearchRun`. `GET /api/search/:id` — JSON snapshot or SSE (`event: progress|done|error` here; `job` added in B6), monotonic `id:`, `stage` values `sources→fetch→score→legitimacy→done`. Register in B3.
- [ ] TDD: connectors against fixture HTTP; `roleFuzzyMatch` + `dedupe` + `RoleTarget`-derivation unit tests; a full run with mocked connectors populates `jobs` on PGlite and emits ordered `progress`/`done` SSE events; partial-failure recorded, run still `completed`.

**Deliverable:** `POST /api/search` with mocked connectors upserts `jobs` and streams progress; tests green.
**Commit:** `feat(b5): source connectors + search run (F2 discovery) + /api/search`

---

## B6 — `server/score` (F2 scoring + 5-tier legitimacy) + `/api/jobs`

**Files:** `src/server/score/{index.ts,jdFacts.ts,evalScores.ts,legitimacy.ts,liveness.ts}`, `src/features/feed/assemble.ts`, `src/app/api/jobs/route.ts`, `src/app/api/jobs/[id]/route.ts`, tests. Wire scoring into B5's `run.ts`.

**Interfaces:**
- Consumes: `jobsRepo`, `jobScoresRepo` (B1); `getLlm` (B2); `Job`, `Legitimacy`, `Tone`, `SummaryStripStats` (`src/types`).
- Produces: `scoreJob(...)`, `assembleJob(...)` (Locked interfaces); `GET /api/jobs`, `GET /api/jobs/:id`.

**Tasks:**
- [ ] `jdFacts.ts`: Stage-1 `jd-extract` template → `JdFacts` (donor). `evalScores.ts`: Stage-2 `match-score` → `EvalScores` with `shouldEscalate` → stronger model; `global = weighted_mean − red_flag_penalty`. **Stage 3 Deep is cut.**
- [ ] `legitimacy.ts`: 5-tier mapping — donor `High Confidence→clear`, `Caution/Suspicious→suspicious`, liveness `expired→ghost`, `scam` = new template output; `verified` reserved for corroborated signals. `legitimacyTone(tier)` lives here (single source; components never hand-pick tone). Block G lives inside eval output (no separate `verdict.ts`).
- [ ] `liveness.ts`: in-process HTTP probe (+ optional Playwright) → `active|expired|uncertain`. No `check-liveness.mjs` shell-out. **Install Playwright here** (resolves finding 12) — it is first needed by this `liveness` probe and by B7 tier-2 `dom-parse`; only the PDF **base-image validation gate** stays in B8.
- [ ] `index.ts` `scoreJob`: liveness + jdFacts + evalScores → `job_scores` row (`score, verdict, legitimacy, breakdown, reasons, fit, gaps, model, escalated, costUsd, policyVersion`). UNIQUE `(jobId,resumeId,policyVersion)` = verdict cache. **Per-run cost cap (~30 jobs) + daily cap env var.**
- [ ] `assemble.ts`: `jobs ⋈ job_scores` → frozen §5 `Job` (`applyUrl`, `source: SourceRef`, `persona`, `firstSeen`, `isNew`, tags/breakdown/fit/gaps/legitimacy). Assembly lives in `features/feed`, not `server`. **applyUrl resolution (resolves finding 6):** `Job.applyUrl = row.applyUrl ?? row.url` — a documented assembly rule (`jobs.applyUrl` is the nullable resolved-redirect; `jobs.url` is the always-present canonical listing). Add this rule to `api-contract.md`'s `applyUrl` comment so it is contract, not a silent default.
- [ ] Routes: `GET /api/jobs` — validated query (unknown params rejected), returns `{items, nextCursor, stats: SummaryStripStats}` (stats computed server-side over full scoped set, not the page). **Define `flagged`/`sinceLast` (resolves finding 15):** `flagged` = count of jobs in scope with `legitimacy.tier ∈ {suspicious, ghost, scam}`; `sinceLast` = count with `firstSeenAt` > the previous **completed** search run's `finishedAt` (the "new since last visit" marker; 0 if no prior run). `GET /api/jobs/:id` → frozen `Job` | 404 (no separate `MatchDetail`; tabs derived from `Job`).
- [ ] Wire `scoreJob` into B5 `run.ts` top-N candidates, and **emit the scored `job` SSE event here** (resolves finding 5) — this is where a full `Job` first exists. Also register the `text/event-stream` `job` variant for the search GET in the B3 registry.
- [ ] TDD (mocked LLM): scoreJob produces a row per tier incl. escalation; legitimacy mapping table test; `assembleJob` round-trips to a valid `Job`; `/api/jobs` filter/cursor/stats correctness.

**Deliverable:** a mocked-LLM search run yields scored `Job`s at `GET /api/jobs` with correct `stats`; tests green.
**Commit:** `feat(b6): scoring + 5-tier legitimacy + Job assembly + /api/jobs`

---

## B7 — `server/apply-assistant` (F4) + `/api/apply/*`

**Files:** `src/server/apply-assistant/{extract-questions.ts,answer.ts,dom-parse.ts}`, `src/app/api/apply/questions/route.ts`, `src/app/api/apply/answers/route.ts`, `src/app/api/apply/answers/[id]/route.ts`, tests.

**Interfaces:**
- Consumes: `getLlm` (B2), `jobsRepo`, `resumesRepo`, `applicationAnswersRepo` (B1); `ApplicationQuestion`, `ApplicationAnswers`, `ApplicationAnswer` (`src/types` — **not** the component-inventory sketch).
- Produces: `extractQuestions({jobId?,url?,pastedForm?}) : Promise<{questions: ApplicationQuestion[]; sourceUrl: string|null}>`; `draftAnswers({jobId, questions}) : Promise<ApplicationAnswers>`; the three routes.

**Tasks:**
- [ ] Three-tier extraction (§5): (1) structured ATS API (Greenhouse `…/jobs/{id}?questions=true`); (2) `dom-parse.ts` port of donor `extractFieldsInPage`/`snapshotGreenhouseForm` via in-process Playwright (remote-ATS only; login-gated boards fail → fall through); (3) **paste fallback (always available)** — `question-extract` template parses pasted text → `ApplicationQuestion[]`. Never return `[]` as a guess → `502 EXTRACTION_FAILED`.
- [ ] `answer.ts`: `question-answer` template (mid-tier), grounded on `ResumeStore` + `JdFacts`; every answer carries `grounding[]` (source ∈ experience/skills/summary/headline + quote); ungrounded answers still return with **empty grounding** (UI flags, never silently dropped). Persist `application_answers` row (`model`, `costUsd`).
- [ ] Routes: `POST /api/apply/questions` (`.refine` exactly one of jobId/url/pastedForm → 422 else); `POST /api/apply/answers` (`409` no résumé; `502 UPSTREAM_LLM_ERROR`); `PATCH /api/apply/answers/:id` (edits + per-question regenerate persist; empty patch → 422). Register in B3.
- [ ] TDD (mocked LLM): tier-3 paste path end-to-end (the universal guarantee); grounding present + ungrounded-empty case; refine-validation 422s; PATCH persists.

**Deliverable:** paste-form → grounded drafted answers persisted and editable; tests green.
**Commit:** `feat(b7): apply-question assistant (F4) + /api/apply/*`

---

## B8 — `server/tailor` (F6) + `lib/pdf` + `/api/tailor/*`

**Files:** `src/server/tailor/index.ts`, `src/lib/resume-render.ts` (lift donor `renderCvHtml`), `src/lib/pdf.ts` (Playwright), `src/app/api/tailor/route.ts`, `src/app/api/tailor/[id]/route.ts` (SSE), `src/app/api/tailor/[id]/finalize/route.ts`, `src/app/api/tailor/[id]/pdf/route.ts`, tests.

**Interfaces:**
- Consumes: `getLlm` (B2), `tailoredResumesRepo`, `jobsRepo`, `resumesRepo`, `jobScoresRepo` (for gaps) (B1); `runRegistry` (B5); `TailoredResume`, `Resume` (`src/types`).
- Produces: `startTailor({jobId}) : TailoredResume`; `finalize(id, acceptedIndices) : TailoredResume`; `renderPdf(id) : Buffer`; the four routes.

**Tasks:**
- [ ] `tailor/index.ts`: `tailor` template (strong tier) — inputs ResumeStore + JdFacts + score gaps → **tailored ResumeStore JSON + `diff[]`** (`{section, op: add|remove|modify, before?, after?, reason}` per `src/types`). Draft row `status: 'queued'→'running'→'completed'`. Runs via `runRegistry` (SSE `stage: analyze→rewrite→render→done`).
- [ ] `finalize`: apply only `acceptedIndices` into `src/types` diff → render accepted-only ResumeStore into `TailoredResume.resume`. **`TailoredResume.resume` = `Resume.omit({id, rawText})`, which still requires `atsScore` + `updatedAt` (resolves finding 13):** re-run `server/resume`'s `atsScore.ts` heuristic on the merged ResumeStore for `atsScore`; `updatedAt` = finalize time. Set `finalizedAt` (B1 column) so pdf can gate. `409 RUN_NOT_READY` while `status !== 'completed'`.
- [ ] `resume-render.ts` (pure lift) + `lib/pdf.ts`: `renderCvHtml` → Playwright-Chromium (in-process) → PDF buffer. Validate the Playwright base image (Gate, §6). **LaTeX dropped.**
- [ ] Routes: `POST /api/tailor` (`404` unknown job, `409` no résumé) → `202`; `GET /api/tailor/:id` (JSON/SSE); `POST .../finalize` (`{acceptedIndices}`); `GET .../pdf` (`409 RUN_NOT_READY` until finalized). Register in B3.
- [ ] TDD (mocked LLM): tailor run produces diff; finalize with a subset applies only accepted entries; pdf 409 before finalize then bytes after; SSE stage order.

**Deliverable:** tailor a résumé to a job, accept a subset, export PDF via `next dev`; tests green.
**Commit:** `feat(b8): résumé tailoring (F6) + PDF + /api/tailor/*`

---

## B9 — `server/tracker` (F5) + `/api/applications` + status-map

**Files:** `src/server/tracker/index.ts`, `src/features/applied/status-map.ts`, `src/app/api/applications/route.ts`, `src/app/api/applications/[id]/route.ts`, tests.

**Interfaces:**
- Consumes: `applicationsRepo.insertUniqueByJob`/`listJoined`/`getJoined`/`patch` (B1 — the join supplies `role/company/meta/score`, resolving finding 7); `Application` (`src/types`).
- Produces: `foldStatus(stage, outcome)` (Locked interfaces); `POST`/`GET`/`PATCH /api/applications`.

**Tasks:**
- [ ] `status-map.ts` (resolves finding 4): `foldStatus(stage: 0|1|2|3, outcome: 'open'|'offer'|'closed') → {statusLabel, statusTone}`. Tone is driven by **outcome** (open→`good`, offer→`verified`, closed→`neutral`), not stage alone — `verified`/`neutral` are unreachable from stage. `statusLabel` from the (stage, outcome) pair per §5. Pure, table-tested. **No markdown parsing ported.**
- [ ] `tracker/index.ts`: create (`stage:0, outcome:'open'`→`statusTone:'good'`, server sets `appliedAt`), list via `listJoined` (filter `stage`/`statusTone`, cursor), patch (stage/status/note/tailored/ids; empty patch → 422). Note `PATCH` accepts `statusTone` directly (api-contract §3) — a manual override that coexists with `foldStatus`; the fold is the default on stage moves, the patch is the explicit set.
- [ ] Routes: `POST` → `201 Application`, **unique on `jobId`** → duplicate `409` with `details:{existingId}`; `GET` → `{items, nextCursor}`; `PATCH` → `200|404`. Register in B3.
- [ ] TDD: create + duplicate-409; status-fold table; stage-move PATCH; list filters.

**Deliverable:** mark-applied persists a tracker row; stage moves fold status correctly; tests green.
**Commit:** `feat(b9): application tracker (F5) + /api/applications + status-map`

---

## B10 — Wiring + end-to-end click-through

**Files:** `src/features/*/client.ts` (typed fetch wrappers per feature), wire injectable props in the existing compositions/pages, `src/app/(routes)` pages for the spine, remove fixture-in-prod imports. Tests: a Playwright/next e2e over the F1→F6 happy path.

**Interfaces:**
- Consumes: every route above; the injectable-prop components (already wiring-ready per `f044503`).
- Produces: `features/<feature>/client.ts` fetch wrappers that take/return `z.infer` types and `.parse` responses in dev/test (catches drift at runtime).

**Tasks:**
- [ ] `features/*/client.ts`: one wrapper per feature (resume/feed/search/apply/tailor/applied), `.parse` on response. No component imports `server/*` or `lib/llm` directly.
- [ ] Wire the injectable handler props (F4/F6 de-faked in `f044503`) to the real client wrappers; swap fixtures for live/MSW data; delete any fixture import that reached production code.
- [ ] F3 apply-out: plain `<a target="_blank" rel="noopener" href={job.applyUrl}>` (resolves finding 6 — `Job` has no `url`; `applyUrl` is required and already resolved in `assembleJob`). No server round-trip.
- [ ] **Upload-triggered dual-persona search (resolves finding 9):** the F1→F2 flow ("search both personas on upload", arch §3/§4) is not a contract change — the frozen `POST /api/search` takes one persona. B10 fires **two POSTs** (one per persona) after résumé confirm, and the Feed's `PersonaToggle` reads whichever run's jobs. Document this in the feature wrapper; do not add a "both" persona to the contract.
- [ ] App pages for the spine (Resume, Feed, JobDetail, ApplyAssistant, Tailor, Tracker) rendering real data.
- [ ] e2e: upload résumé → search (mocked connectors + LLM in test env) → feed → open detail → answer questions → mark applied → tailor → PDF. Assert each transition.
- [ ] Run `/run` (or `/verify`) to drive the real app once and confirm the spine works, not just tests.

**Deliverable:** `next dev` serves the full F1–F6 spine on real services; e2e green; `/run` confirms it in the browser.
**Commit:** `feat(b10): wire components to backend + e2e spine`

---

## Self-review (spec coverage)

- **F1** → B4 (+ storage B1, extract B4). **F2** → B5 (discovery) + B6 (scoring/legitimacy/feed). **F3** → B10 `<a>`. **F4** → B7. **F5** → B9. **F6** → B8.
- **Every api-contract endpoint** is placed: `/api/resume`×2 (B4), `/api/search`×2 (B5), `/api/jobs`×2 (B6), `/api/apply/*`×3 (B7), `/api/applications`×3 (B9), `/api/tailor/*`×4 (B8), `/api/docs` (B3), `/api/health` (B0).
- **All 8 Drizzle tables** (B1). **SSE run pattern** (B5 search, B8 tailor). **OpenAPI/Scalar** (B3). **Cost cap** (B6/B7/B8 rows). **Donor corrections** honored (no scan_jobs, no verdict.ts, mammoth, no LaTeX, Stage-3 cut) across B4/B5/B6/B8.
- **Contract discrepancy resolved:** all slices bind to `src/types` shapes; `component-inventory.md` §2/§3 sketches are explicitly overridden.
- **Deferred (not in Phase B):** `Explorations/FeedTreatments`; sources CRUD, cover letters, interviews, insights, profile (Phases C–D); validation gates (ghost-scorer precision, cost/user, prepay) are product gates, not build tasks.

**Open questions for the operator:**
1. **DB mechanism (blocks B1):** confirm **Postgres-everywhere + PGlite for tests** (recommended, deviates from the docs' "SQLite dev" line) vs dual pg/sqlite schema. If PG-everywhere, `system-architecture.md §6.7` should be updated to match.
2. `config/models.yml` — which OpenRouter model ids for cheap/mid/strong tiers? (Blocks B6 real-token spend; B2 wires the mechanism with placeholders.)
3. Playwright base image for PDF (§6, Gate) — validate in B8; is a Docker target in scope for Phase B or deferred to deploy? (Playwright itself installs in B6.)
4. MY-board reality check: JobStreet listing endpoint/HTML shape must be probed live before B5 finalizes that connector (only truly unproven component).
5. **Contract touch-ups (do at the slice that needs them, per the "update contract first" rule):** add `GET /api/health` row (B0); add the `applyUrl = applyUrl ?? url` assembly rule to the `applyUrl` comment (B6); confirm `stats.worth = verdict ∈ {Apply,Consider}` and the dual-persona-via-two-POSTs upload flow (B5/B10) are acceptable or should become explicit contract notes.
