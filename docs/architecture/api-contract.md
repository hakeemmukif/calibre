# Caliber API Contract v1 (MVP)

Schema-first: Zod schemas in `src/types` are the single source of truth; OpenAPI, TS types, and runtime validation all derive from them (§12). Entities align with the frozen §5 contract plus §11.8 hero extensions. Auth: **none in v1** (single-operator, §1 non-goals) — protect at the network layer; every route below is unauthenticated and this is recorded in OpenAPI as a v1 constraint.

## 1. Endpoint table

| # | Method | Path | Purpose | Mode |
|---|---|---|---|---|
| F1 | POST | `/api/resume` | Upload (multipart PDF/DOCX) or paste (JSON) → parse → persist structured `Resume` | sync |
| F1 | GET | `/api/resume` | Fetch the current résumé | sync |
| F2 | POST | `/api/search` | Start a dual search run (global ATS + MY boards) scored against the résumé | async, 202 |
| F2 | GET | `/api/search/:id` | Run status. JSON snapshot by default; **SSE** when `Accept: text/event-stream` | sync / SSE |
| F2 | GET | `/api/jobs` | Scored feed (filterable, cursored) | sync |
| F2/F3 | GET | `/api/jobs/:id` | Single job incl. `applyUrl` (F3 is client-side: open `applyUrl`; no apply endpoint) | sync |
| F4 | POST | `/api/apply/questions` | Extract application questions from a posting URL or pasted form | sync (LLM) |
| F4 | POST | `/api/apply/answers` | Draft résumé-grounded answers for extracted questions | sync (LLM) |
| F4 | PATCH | `/api/apply/answers/:id` | Edit a persisted answer set (user edits/regenerates after drafting) | sync |
| F5 | POST | `/api/applications` | Mark applied (persist tracker row) | sync |
| F5 | GET | `/api/applications` | List tracker rows | sync |
| F5 | PATCH | `/api/applications/:id` | Update stage / status / note / tailored flag | sync |
| F6 | POST | `/api/tailor` | Start tailoring the résumé to a job | async, 202 |
| F6 | GET | `/api/tailor/:id` | Tailor status + result; SSE via `Accept: text/event-stream` | sync / SSE |
| F6 | POST | `/api/tailor/:id/finalize` | Persist the accepted-only diff (renders an accepted-only résumé) | sync |
| F6 | GET | `/api/tailor/:id/pdf` | Rendered PDF of the finalized (accepted-only) résumé | sync, binary |
| — | GET | `/api/profile` | Operator profile (base country + relocation). 404 when unseeded | sync |
| — | PUT | `/api/profile` | Full-replace the operator profile | sync |
| — | GET | `/api/health` | Liveness check, unauthenticated | sync |

`GET /api/jobs/:id` returns the frozen `Job` entity verbatim — there is no separate detail/`MatchDetail` entity in MVP; `JobDetail`'s Fit/Legitimacy/Breakdown tabs are derived entirely from `Job.fit`/`Job.legitimacy`/`Job.breakdown`. An `archetype` field (e.g. "Global remote — APAC-friendly") was drafted during component design but is **deferred** — not part of `Job`, not returned by this route.

Search and tailor share one **run pattern**: `POST` returns `202` with the run entity; the `GET :id` route serves both polling (JSON) and streaming (SSE) via content negotiation — one path, two documented content types in OpenAPI.

## 2. Core Zod schemas (`src/types`)

```ts
export const Persona = z.enum(['remote', 'local']);
export const LegitimacyTier = z.enum(['verified','clear','suspicious','ghost','scam']);   // §11.8
export const Tone = z.enum(['verified','good','warn','ghost','danger']);

export const Legitimacy = z.object({
  tier: LegitimacyTier, tone: Tone, summary: z.string(),
  confidence: z.number().min(0).max(1).optional(),   // only if scorer emits a real number (§11.8 D/G)
});

export const SourceRef = z.object({                  // Source entity, referenced from Job
  id: z.string(), name: z.string(), kind: z.enum(['ats','board']), persona: Persona,
});

export const RelocationPref = z.enum(['stay', 'open']);

// Operator profile — singleton (single-operator MVP). baseCountry is
// ISO-3166-1 alpha-2 ('MY' at launch). The seed row IS the install step
// (seed.ts precedent); a missing row is a 404, never a runtime default.
// (2026-07-12-remote-local-eligibility-design.md §3.)
export const Profile = z.object({
  baseCountry: z.string().length(2),
  relocation: RelocationPref,
  updatedAt: z.string().datetime(),
});

export const Job = z.object({                        // §5 frozen + §11.8 extensions
  id: z.string(), score: z.number().min(0).max(5), ghost: z.boolean().optional(),
  role: z.string(), company: z.string(), meta: z.string(),
  verdict: z.string(), why: z.string(),
  tags: z.array(z.object({ tone: Tone, label: z.string() })),
  breakdown: z.array(z.object({ label: z.string(), value: z.number(),
    display: z.string().optional(), tone: Tone.optional() })),
  fit: z.array(z.object({ k: z.string(), v: z.string() })),
  gaps: z.array(z.object({ tone: z.enum(['warn','ok']), k: z.string(), v: z.string() })),
  legitimacy: Legitimacy,
  applyUrl: z.string().url(),                        // F3: the canonical posting URL
  // Assembly rule (features/feed/assemble.ts, B6): applyUrl = jobs.applyUrl ?? jobs.url —
  // jobs.applyUrl is the nullable resolved-redirect (set on fetchDetail, F3 hard problem
  // "Apply-URL capture"); jobs.url is the always-present canonical posting URL. This is a
  // documented fallback, not a silent default: a job with no resolved redirect yet still
  // gets a valid applyUrl from its own canonical listing URL.
  source: SourceRef, persona: Persona,
  firstSeen: z.string().datetime(), isNew: z.boolean(),
});

export const Resume = z.object({                     // §5; `hasResume` is NOT a field — absence = 404
  id: z.string(), atsScore: z.number().int().min(0).max(100),
  updatedAt: z.string().datetime(),                  // wire form of kit's `updated`; UI derives "3d ago"
  headline: z.string(), location: z.string(), summary: z.string(),
  experience: z.array(z.object({ title: z.string(), company: z.string(),
    dates: z.string(), bullets: z.array(z.string()) })),
  skills: z.array(z.string()),
  rawText: z.string(),                               // parse provenance, grounds F4/F6
});

export const RunStatus = z.enum(['queued','running','completed','failed']);
export const Progress = z.object({                   // donor JobProgress shape
  stage: z.string(), current: z.number().int(), total: z.number().int(), label: z.string(),
});

export const SearchRun = z.object({
  id: z.string(), status: RunStatus, persona: Persona,
  sources: z.array(z.string()),                      // SourceRef ids in scope
  progress: Progress.nullable(),
  stats: z.object({ scanned: z.number().int(), worth: z.number().int(),
    ghosts: z.number().int() }),                     // §5 ScanStats
  startedAt: z.string().datetime(), finishedAt: z.string().datetime().nullable(),
  error: z.string().nullable(),
});

export const SummaryStripStats = z.object({          // Feed hero row (§11.8); GET /api/jobs' `stats`
  scanned: z.number().int(), worth: z.number().int(), ghosts: z.number().int(),
  flagged: z.number().int(), sinceLast: z.number().int(),
});

export const Application = z.object({                // §5 Applied, wire-normalised
  id: z.string(), jobId: z.string(),
  role: z.string(), company: z.string(), meta: z.string(),
  appliedAt: z.string().datetime(),                  // `appliedAgo` derived client-side
  score: z.number().min(0).max(5),
  stage: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),  // Applied→Screen→Interview→Decision
  statusLabel: z.string(), statusTone: z.enum(['good','verified','neutral']), // neutral = closed
  tailored: z.boolean(), note: z.string(),
  tailoredResumeId: z.string().nullable(), answersId: z.string().nullable(),
});

export const ApplicationQuestion = z.object({
  id: z.string(), prompt: z.string(),
  kind: z.enum(['text','textarea','select','multiselect','boolean','file']),
  options: z.array(z.string()).optional(),           // required iff kind is (multi)select
  required: z.boolean(), maxLength: z.number().int().optional(),
});

export const ApplicationAnswer = z.object({
  questionId: z.string(), prompt: z.string(), answer: z.string(),
  grounding: z.array(z.object({ source: z.enum(['experience','skills','summary','headline']),
    quote: z.string() })),                           // every claim traces to the résumé
});
export const ApplicationAnswers = z.object({         // persisted set entity
  id: z.string(), jobId: z.string(), resumeId: z.string(),
  answers: z.array(ApplicationAnswer), model: z.string(), createdAt: z.string().datetime(),
});

export const TailoredResume = z.object({
  id: z.string(), jobId: z.string(), resumeId: z.string(), status: RunStatus,
  progress: Progress.nullable(),
  resume: Resume.omit({ id: true, rawText: true }).nullable(),   // null until completed
  diff: z.array(z.object({ section: z.string(), op: z.enum(['add','remove','modify']),
    before: z.string().optional(), after: z.string().optional(), reason: z.string() })),
  model: z.string(), createdAt: z.string().datetime(), completedAt: z.string().datetime().nullable(),
});

export const ErrorEnvelope = z.object({
  error: z.object({
    code: z.enum(['VALIDATION_ERROR','NOT_FOUND','CONFLICT','RUN_NOT_READY',
      'PARSE_FAILED','EXTRACTION_FAILED','UPSTREAM_LLM_ERROR','PAYLOAD_TOO_LARGE']),
    message: z.string(),
    details: z.unknown().optional(),                 // e.g. ZodIssue[] for VALIDATION_ERROR
  }),
});
```

## 3. Per-endpoint I/O

Boundary rule everywhere: `Schema.parse(body)` at the route handler; `ZodError` → **422** `VALIDATION_ERROR` with `issues` in `details`. No defaults injected — a missing required field always fails loud (fintech rule).

**POST /api/resume** — `multipart/form-data` (`file`: PDF/DOCX, ≤10 MB) **or** `application/json` `{ text: z.string().min(100) }`. → `200 Resume`. Errors: `413 PAYLOAD_TOO_LARGE`, `422` (bad mime/empty text), `502 PARSE_FAILED` (unpdf/LLM extraction failed — no partial résumé is ever persisted). Idempotent-by-replacement: v1 holds exactly one résumé; a new upload atomically supersedes it.

**GET /api/resume** — → `200 Resume` | `404 NOT_FOUND`. No `{hasResume:false}` sentinel — absence is a 404 and the kit's `hasResume` flag is derived client-side.

**GET /api/profile** — → `200 Profile` | `404 NOT_FOUND` (unseeded install — the seed is the install step; no runtime default). **PUT /api/profile** — `Profile.omit({ updatedAt })` full replace. → `200 Profile` | `404` | `422`.

**POST /api/search** — `{ persona: Persona, sources?: z.array(z.string()).min(1).optional() }` (omitted `sources` = persona's full configured set — an explicit empty array is a 422, not a silent all). → `202 SearchRun` (`status:'queued'`). `409 CONFLICT` if a run is already active for that persona (`details: { activeRunId }`). `409` also if no résumé exists (search scores against it).

**GET /api/search/:id** — → `200 SearchRun` | `404`. With `Accept: text/event-stream` → SSE (§4).

**GET /api/jobs** — query (all validated, unknown params rejected): `persona?`, `tier?` (repeatable), `minScore?` (0–5), `isNew?`, `remote?`, `q?`, `cursor?`, `limit?` (1–100, default 25). → `200 { items: Job[], nextCursor: string | null, stats: SummaryStripStats }`. Params map 1:1 to the §11.8 hero filter chips. `stats` is the Feed hero row's numbers (scanned/worth/ghosts/flagged/sinceLast) computed server-side over the full scoped result set, not derived client-side from the (paginated) `items` page.

**GET /api/jobs/:id** — → `200 Job` | `404`.

**POST /api/apply/questions** — `{ jobId?, url?, pastedForm? }` with `.refine` requiring **exactly one** of the three (422 otherwise). → `200 { questions: ApplicationQuestion[], sourceUrl: string | null }`. Errors: `404` (unknown jobId), `502 EXTRACTION_FAILED` (unfetchable URL / no questions found — never returns `[]` as a guess).

**POST /api/apply/answers** — `{ jobId, questions: ApplicationQuestion[].min(1) }`. → `200 ApplicationAnswers`. `409` if no résumé; `502 UPSTREAM_LLM_ERROR`. Grounding array is required per answer — an answer the model can't ground still returns, with empty `grounding`, so the UI can flag it (visible, not silently dropped).

**PATCH /api/apply/answers/:id** — `{ answers: ApplicationAnswer[].min(1) }` (empty patch → 422). → `200 ApplicationAnswers` | `404`. Covers user edits and per-question regenerate/redraft after the initial `POST /api/apply/answers` — the assistant's Regenerate/edit actions persist through this route rather than mutating client-only state.

**POST /api/applications** — `{ jobId, note?, tailoredResumeId?, answersId? }`. → `201 Application` (server sets `appliedAt`, `stage: 0`, `statusLabel/statusTone` via `features/applied/status-map.ts`). **Idempotency: unique on `jobId`** → duplicate `409 CONFLICT` with `details: { existingId }`. `404` unknown job id; `409 CONFLICT` if the job exists but has no `job_scores` row yet (a job must be scored before it can be tracked — `Application.score` has no other source).

**GET /api/applications** — query `stage?`, `statusTone?`, `cursor?`, `limit?`. → `200 { items: Application[], nextCursor }`.

**PATCH /api/applications/:id** — partial of `{ stage, statusLabel, statusTone, note, tailored, tailoredResumeId, answersId }` (empty patch → 422). → `200 Application` | `404`.

**POST /api/tailor** — `{ jobId }`. → `202 TailoredResume` (queued). `404` unknown job, `409` no résumé.

**GET /api/tailor/:id** — → `200 TailoredResume` | `404`; SSE via Accept header.

**POST /api/tailor/:id/finalize** — `{ acceptedIndices: z.array(z.number().int()) }` (indices into `TailoredResume.diff`). → `200 TailoredResume`, server-rendered with only the accepted diff entries applied (`resume` reflects the accepted-only merge, not the full-tailor draft). `404` unknown id, `409 RUN_NOT_READY` while `status !== 'completed'`. The accept/reject mask never lives only in client state — the UI's ChangeList/ExportBar accept flags are indices passed here, and `GET /api/tailor/:id/pdf` renders whatever this route last finalized.

**GET /api/tailor/:id/pdf** — → `200 application/pdf` | `404` | `409 RUN_NOT_READY` while the run hasn't been finalized (`POST .../finalize` not yet called, or `status !== 'completed'`).

## 4. Streaming (SSE)

Both run endpoints emit the same envelope; every `data:` payload is schema-validated JSON, and events carry monotonic `id:` for `Last-Event-ID` resume:

```ts
// event: progress → Progress   e.g. {stage:'boards', current:3, total:7, label:'Scanning Hiredly…'}
// event: job      → Job        (search only: scored job streamed into the feed as found)
// event: done     → SearchRun | TailoredResume   (terminal snapshot, then close)
// event: error    → ErrorEnvelope                (terminal, then close)
export const SseEvent = z.discriminatedUnion('event', [
  z.object({ event: z.literal('progress'), data: Progress }),
  z.object({ event: z.literal('job'),      data: Job }),
  z.object({ event: z.literal('done'),     data: z.union([SearchRun, TailoredResume]) }),
  z.object({ event: z.literal('error'),    data: ErrorEnvelope }),
]);
```

`stage` values — search: `sources → fetch → score → legitimacy → done`; tailor: `analyze → rewrite → render → done`. Donor `JobProgress` shape, so ScanProgress binds unchanged.

## 5. OpenAPI & typed client

- **Schemas** live co-located with the frozen contract in `src/types/*.ts` — one Zod object per entity/request/response, exported alongside `z.infer` types. Server, routes, and UI import these; no second type system.
- **Contract module** `src/contract/`: `registry.ts` registers every schema + path with `@asteasolutions/zod-to-openapi` (both JSON and `text/event-stream` on the run GETs); `generate.ts` (via `npm run contract`) emits `contract/openapi.json`, committed and diffed in PRs.
- **Docs**: `contract/openapi.json` served through a Scalar page at `/api/docs`.
- **Typed client**: internally none generated — one Next.js codebase, so `features/*` fetch wrappers take/return `z.infer` types and `.parse` responses in dev/test (catching drift at runtime). OpenAPI exists for docs and future external codegen.

Sources are real (`GET /api/sources` → `{ items: Source[] }`, `PATCH /api/sources/:id` `{enabled}` → `Source`; `/sources` page). Deferred (out of this contract): cover letters, interviews, insights, notifications — same run/entity patterns when their screens are wired (Phases C–D).
