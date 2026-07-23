# Caliber API Contract v1 (MVP)

> The Zod snapshots embedded below are convenience copies, kept close to the prose they explain. `src/types/index.ts` and the generated `contract/openapi.json` are canonical — when this document and the code disagree, the code wins.

Schema-first: Zod schemas in `src/types` are the single source of truth; OpenAPI, TS types, and runtime validation all derive from them (§12). Entities align with the frozen §5 contract plus §11.8 hero extensions. Auth: email+password sessions. Registration/login mint an opaque token stored as a SHA-256 hash; it rides in an httpOnly SameSite=Lax cookie (`caliber_session`). Route handlers enforce via `requireUser()`/`requireAdmin()` (never Next middleware); `/api/health` and the auth routes themselves are the only unauthenticated endpoints. Every user-owned table carries a `user_id` and every route scopes reads/writes to the caller (§1a); `/api/admin/*` gives admins read access to any user's content via the same scoped repos (§1b).

## 1. Endpoint table

| # | Method | Path | Purpose | Mode |
|---|---|---|---|---|
| — | POST | `/api/auth/register` | Create a `user`-role account, auto-login | sync |
| — | POST | `/api/auth/login` | Verify credentials, mint a session | sync |
| — | POST | `/api/auth/logout` | Clear the session (idempotent) | sync |
| — | GET | `/api/auth/session` | Current user from the session cookie | sync |
| — | PATCH | `/api/auth/password` | Self-serve change password (reverifies current, kills every session, mints a fresh one) | sync |
| — | GET | `/api/credits` | Caller's wallet balance + plan, for the header chip | sync |
| F1 | POST | `/api/resume` | Upload (multipart PDF/DOCX) or paste (JSON) → parse → persist structured `Resume` | sync |
| F1 | GET | `/api/resume` | Fetch the current résumé | sync |
| F2 | POST | `/api/search` | Start a dual search run (global ATS + MY boards) scored against the résumé | async, 202 |
| F2 | GET | `/api/search/:id` | Run status. JSON snapshot by default; **SSE** when `Accept: text/event-stream` | sync / SSE |
| F2 | GET | `/api/jobs` | Scored feed (filterable, cursored) | sync |
| F2/F3 | GET | `/api/jobs/:id` | Single job incl. `applyUrl` (F3 is client-side: open `applyUrl`; no apply endpoint) | sync |
| — | POST | `/api/jobs/:id/evaluate` | On-demand re-score of an already-persisted job, outside a search run | sync (LLM) |
| F4 | POST | `/api/apply/questions` | Extract application questions from a posting URL or pasted form | sync (LLM) |
| F4 | POST | `/api/apply/answers` | Draft résumé-grounded answers for extracted questions | sync (LLM) |
| F4 | PATCH | `/api/apply/answers/:id` | Edit a persisted answer set (user edits/regenerates after drafting) | sync |
| F5 | POST | `/api/applications` | Mark applied (persist tracker row) | sync |
| F5 | GET | `/api/applications` | List tracker rows | sync |
| F5 | PATCH | `/api/applications/:id` | Update stage / status / note / tailored flag | sync |
| F6 | POST | `/api/tailor/correlate` | Start correlating the résumé against a job's requirements | async, 202 |
| F6 | GET | `/api/tailor/correlate/:id` | Correlation status + result; SSE via `Accept: text/event-stream` | sync / SSE |
| F6 | POST | `/api/tailor` | Start tailoring the résumé to a job (`{ jobId, reportId? }`) | async, 202 |
| F6 | GET | `/api/tailor/:id` | Tailor status + result; SSE via `Accept: text/event-stream` | sync / SSE |
| F6 | POST | `/api/tailor/:id/finalize` | Persist the accepted-only diff (renders an accepted-only résumé) | sync |
| F6 | GET | `/api/tailor/:id/pdf` | Rendered PDF of the finalized (accepted-only) résumé | sync, binary |
| F7 | POST | `/api/jobs/check` | Paste-URL front door: fetch→sonar-search→paste-text ladder, gate, persist, ghost-check, score | async, 202 |
| F7 | GET | `/api/jobs/check/:id` | Poll a pasted-URL check's stage/result | sync |
| F7 | DELETE | `/api/jobs/:id` | Delete a pasted job (persona `pasted` only; blocked if a tracked application exists) | sync |
| — | GET | `/api/profile` | Caller's own profile (base country + relocation). 404 when the caller hasn't onboarded yet | sync |
| — | PUT | `/api/profile` | Upsert (create-or-replace) the caller's own profile — also the onboarding path | sync |
| — | GET | `/api/health` | Liveness check, unauthenticated | sync |
| — | POST | `/api/client-error` | Client crash beacon (rate-limited, fire-and-forget) | sync |
| — | GET | `/api/docs` | Scalar-rendered OpenAPI reference page (serves `contract/openapi.json`) | sync |
| — | GET | `/api/admin/users` | Admin: list every account + per-user résumé/job/application counts + credit balance/plan | sync |
| — | GET | `/api/admin/users/:id/resume` | Admin: target user's active résumé | sync |
| — | GET | `/api/admin/users/:id/jobs` | Admin: target user's scored feed (same query params as `GET /api/jobs`) | sync |
| — | GET | `/api/admin/users/:id/applications` | Admin: target user's tracker rows (same query params as `GET /api/applications`) | sync |
| — | POST | `/api/admin/users/:id/credits` | Admin: grant/debit a user's credit balance (signed `delta`) | sync |
| — | GET | `/api/admin/sources` | Admin: source health surface (enabled/dead counts + per-source health) | sync |
| — | GET | `/api/admin/crawl` | Admin: live crawl status + pool health (pool/staleness/running crawl/last runs/per-source) | sync |
| — | GET | `/api/admin/pool` | Admin: postings pool composition snapshot (function mix/tz bands/freshness/concentration) | sync |

`GET /api/jobs/:id` returns the frozen `Job` entity verbatim — there is no separate detail/`MatchDetail` entity in MVP; `JobDetail`'s Fit/Legitimacy/Breakdown tabs are derived entirely from `Job.fit`/`Job.legitimacy`/`Job.breakdown`. An `archetype` field (e.g. "Global remote — APAC-friendly") was drafted during component design but is **deferred** — not part of `Job`, not returned by this route.

Search and tailor share one **run pattern**: `POST` returns `202` with the run entity; the `GET :id` route serves both polling (JSON) and streaming (SSE) via content negotiation — one path, two documented content types in OpenAPI.

## 1a. Auth

Email+password sessions, cookie-based. `Schema.parse(body)` boundary rule applies (§3) — `422 VALIDATION_ERROR` on bad input.

**POST /api/auth/register** — `{ email, password }` (password min 8). Creates a `user`-role account (never `admin`) and auto-logs-in. → `201 { user: AuthUser }`, sets the `caliber_session` cookie. `409 CONFLICT` if the email is taken. `422 VALIDATION_ERROR` on bad input.

**POST /api/auth/login** — `{ email, password }`. → `200 { user: AuthUser }`, sets the `caliber_session` cookie. `401 UNAUTHORIZED` on bad credentials — identical error whether the email doesn't exist or the password is wrong (no user enumeration). `422 VALIDATION_ERROR` on bad input.

**POST /api/auth/logout** — clears the cookie and deletes the session row. → `204`. Idempotent (no cookie / an already-deleted session is not an error).

**GET /api/auth/session** — → `200 { user: AuthUser }` if logged in, else `401 UNAUTHORIZED`.

The session cookie (`caliber_session`) is httpOnly, `SameSite=Lax`, `Secure` unless `SESSION_COOKIE_SECURE=false` (local http dev only), 30-day `maxAge`. Its value is an opaque random token; only its SHA-256 hash is persisted (`sessions` table), so a DB read never yields a usable token. Route handlers call `requireUser()` (any authenticated user) or `requireAdmin()` (role `admin`) — enforcement lives in the handler, not in Next middleware. `ErrorCode` gained two values for this: `UNAUTHORIZED` (401) and `FORBIDDEN` (403).

Per-user data scoping is live: `user_id` (NOT NULL) sits on all 10 user-owned tables (`profile, resumes, search_runs, jobs, job_scores, application_answers, tailored_resumes, correlation_reports, url_checks, applications`) — `sources` stays global reference data. Every route below threads `requireUser()`'s `session.id` through to a userId-scoped repo call; a foreign id (another user's job/application/etc.) 404s, it never leaks a cross-tenant row. `profile` is **no longer a singleton** — one row per user (`profile_user_id_unique`), and `PUT /api/profile` upserts (create-or-replace), which doubles as the onboarding path for a fresh registrant with no row yet. Admin-only content routes exist under `/api/admin/*`, `requireAdmin()`-guarded (§1b). The daily LLM cost cap (`CALIBER_DAILY_LLM_USD`) stays **global** across all users for now — a deliberate tripwire, not per-user (see `DEPLOY.md` pre-public tripwires).

## 1b. Admin

All `/api/admin/*` routes call `requireAdmin()` — 401 `UNAUTHORIZED` with no session, 403 `FORBIDDEN` for a non-admin caller (role `user`). Admin access is additive: it never impersonates a login, it reads the same scoped repos/queries the equivalent user-facing route uses, just fed the URL's target `:id` instead of the caller's own session id — no new unscoped query exists for admin.

**GET /api/admin/users** — → `200 { items: AdminUser[] }`. Each `AdminUser` is `{ id, email, role, createdAt, resumeCount, jobCount, applicationCount, balance, plan }` — `.parse()` strips unknown keys (e.g. a stray `passwordHash`), so the hash is never on the wire.

**GET /api/admin/users/:id/resume** — → `200 Resume` | `404` (unknown/non-uuid id, or the target has no résumé yet).

**GET /api/admin/users/:id/jobs** — same query params/response shape as `GET /api/jobs` §3, scoped to the target user. If the target has no profile yet (`ProfileMissingError`), returns `200` with an empty feed (`items: [], stats` all-zero) rather than an error — an admin peeking at a not-yet-onboarded account shouldn't 500.

**GET /api/admin/users/:id/applications** — same query params/response shape as `GET /api/applications` §3, scoped to the target user.

`PATCH /api/sources/:id` (§5) also requires `requireAdmin()` — sources are global reference data but only an admin may toggle a source's `enabled` flag. `GET /api/sources` requires only `requireUser()` (any logged-in caller may read the list; the sources rows themselves stay global/unscoped, not user-owned).

## 2. Core Zod schemas (`src/types`)

```ts
export const Persona = z.enum(['remote', 'local', 'pasted']);   // 'pasted' — 2026-07-12 pasted-job-ingestion spec §2.5
export const ScanPersona = z.enum(['remote', 'local']);          // scan-only boundaries (POST /api/search, sourcesRepo, searchRunsRepo) — widening Persona alone does not propagate
export const LegitimacyTier = z.enum(['verified','clear','suspicious','ghost','scam']);   // §11.8
export const Tone = z.enum(['verified','good','warn','ghost','danger','neutral']);

// Ghost posting-history web-search evidence (pasted jobs only, §8 of the
// 2026-07-12 pasted-job-ingestion spec). Never enters the scoring prompt —
// deterministic overlay + UI evidence line only.
export const GhostWebEvidence = z.object({
  sightings: z.array(z.object({ url: z.string().url(), source: z.string(), postedDate: z.string().optional() })),
  companySignals: z.array(z.string()),
  summary: z.string(),
  confidence: z.number().min(0).max(1),
});
export const WebEvidence = z.discriminatedUnion('status', [
  GhostWebEvidence.extend({ status: z.literal('ok') }),
  z.object({ status: z.literal('failed'), reason: z.string() }),
]);

export const Legitimacy = z.object({
  tier: LegitimacyTier, tone: Tone, summary: z.string(),
  confidence: z.number().min(0).max(1).optional(),   // only if scorer emits a real number (§11.8 D/G)
  webEvidence: WebEvidence.optional(),                // pasted-path repost/corroboration evidence (§9 overlay precedence)
});

// Eligibility — posting geography relative to the operator profile
// (2026-07-12-remote-local-eligibility-design.md §3): anywhere = work-from-
// anywhere (best tier) · eligible = remote, hireable from baseCountry ·
// local = onsite/hybrid in baseCountry · abroad = located elsewhere (onsite
// OR geo-fenced remote; hidden under relocation 'stay') · unknown = posting
// states nothing decidable (honest tier, never silently eligible).
export const EligibilityTier = z.enum(['anywhere','eligible','local','abroad','unknown']);
export const Eligibility = z.object({
  tier: EligibilityTier, tone: Tone, summary: z.string(),   // summary = resolver evidence
});

export const SourceRef = z.object({                  // Source entity, referenced from Job
  id: z.string(), name: z.string(), kind: z.enum(['ats','board','manual']), persona: Persona,
});

export const RelocationPref = z.enum(['stay', 'open']);

export const ScheduleFlex = z.enum(['base-hours', 'flex-evenings', 'any-hours']); // ordered: each level includes the ones before it
export const EmploymentPref = z.enum(['any', 'employee', 'local-entity']); // 'employee' admits local entity OR EOR

// Profile — per-user (one row per user_id, UNIQUE profile_user_id_unique;
// no longer the single-operator MVP's singleton). baseCountry is
// ISO-3166-1 alpha-2 ('MY' at launch). GET 404s when the caller hasn't
// onboarded yet; PUT upserts, which is the onboarding path itself — the
// dials (scheduleFlex/employmentPref) are required on every write, no
// runtime default. (2026-07-12-remote-local-eligibility-design.md §3;
// per-user since the multi-tenant migration.)
//
// Résumé-seeded, user-editable attribute layer (2026-07-22-resume-attributes
// spec §3/§6): displayLocation/targetRole/salary* are nullable (explicitly
// not set; never defaulted). attrProvenance is server-computed, read-only on
// the wire — sticky rule: user edits win, résumé re-seeds only its own
// fields, salary is never résumé-seeded (AttrProvenance.salary is always
// literal 'user' once set).
export const AttrProvenance = z.object({
  displayLocation: z.enum(['resume', 'user']).optional(),
  targetRole: z.enum(['resume', 'user']).optional(),
  salary: z.literal('user').optional(),
});

export const SalaryCadence = z.enum(['monthly', 'annual']);

export const Profile = z.object({
  baseCountry: z.string().length(2),
  relocation: RelocationPref,
  scheduleFlex: ScheduleFlex,
  employmentPref: EmploymentPref,
  displayLocation: z.string().min(1).nullable(),
  targetRole: z.string().min(1).nullable(),
  salaryMin: z.number().int().positive().nullable(),
  salaryMax: z.number().int().positive().nullable(),
  salaryCurrency: z.string().length(3).nullable(),   // ISO-4217
  salaryCadence: SalaryCadence.nullable(),
  attrProvenance: AttrProvenance,
  updatedAt: z.string().datetime(),
})
  // Cross-field: salaryCurrency/salaryCadence required once any salary
  // amount is set; salaryMin <= salaryMax when both are set.
  .superRefine(salaryRules);

export const Job = z.object({                        // §5 frozen + §11.8 extensions
  id: z.string(), score: z.number().min(0).max(5), ghost: z.boolean().optional(),
  role: z.string(), company: z.string(), meta: z.string(),
  verdict: z.string(), why: z.string(),
  tags: z.array(z.object({ tone: Tone, label: z.string(), title: z.string().optional() })),
  breakdown: z.array(z.object({ label: z.string(), value: z.number(),
    display: z.string().optional(), tone: Tone.optional() })),
  fit: z.array(z.object({ k: z.string(), v: z.string() })),
  gaps: z.array(z.object({ tone: z.enum(['warn','ok']), k: z.string(), v: z.string() })),
  legitimacy: Legitimacy,
  eligibility: Eligibility,                          // posting geography vs profile (2026-07-12 spec §3)
  applyUrl: z.string().url(),                        // F3: the canonical posting URL
  // Assembly rule (features/feed/assemble.ts, B6): applyUrl = jobs.applyUrl ?? jobs.url —
  // jobs.applyUrl is the nullable resolved-redirect (set on fetchDetail, F3 hard problem
  // "Apply-URL capture"); jobs.url is the always-present canonical posting URL. This is a
  // documented fallback, not a silent default: a job with no resolved redirect yet still
  // gets a valid applyUrl from its own canonical listing URL.
  source: SourceRef, persona: Persona,
  firstSeen: z.string().datetime(), isNew: z.boolean(),
});

// F7 — async run backing "paste a URL" (2026-07-12 pasted-job-ingestion spec §5).
export const UrlCheckRequest = z.object({
  url: z.string().url(),              // always required — applyUrl + dedupe key
  text: z.string().min(1).optional(), // paste-text fallback; skips fetch/search tiers
});

export const UrlCheck = z.object({
  id: z.string().uuid(), url: z.string().url(), status: RunStatus,
  stage: z.string().nullable(),       // fetching|searching|extracting|persisting|ghost-check|scoring — open string, Progress.stage precedent
  jobId: z.string().uuid().nullable(),
  alreadyKnown: z.boolean(), needsText: z.boolean(),  // needsText keys the paste-textarea UI, not error-code matching
  error: z.object({ code: ErrorCode, message: z.string() }).nullable(),
  createdAt: z.string().datetime(), finishedAt: z.string().datetime().nullable(),
});

export const Resume = z.object({                     // §5; `hasResume` is NOT a field — absence = 404
  id: z.string(), atsScore: z.number().int().min(0).max(100),
  updatedAt: z.string().datetime(),                  // wire form of kit's `updated`; UI derives "3d ago"
  headline: z.string().nullable(), location: z.string().nullable(),  // nullable: non-blocking derivation (2026-07-22-resume-attributes spec §2) — a résumé missing these is still persisted, not discarded
  summary: z.string().optional(),
  experience: z.array(z.object({ title: z.string(), company: z.string(),
    dates: z.string(), bullets: z.array(z.string()) })),
  skills: z.array(z.string()),
  projects: z.array(z.object({ name: z.string(), url: z.string().optional(), bullets: z.array(z.string()) })),
  certifications: z.array(z.object({ name: z.string(), issuer: z.string().optional(), year: z.string().optional() })),
  languages: z.array(z.object({ language: z.string(), proficiency: z.string().optional() })),
  rawText: z.string(),                               // parse provenance, grounds F4/F6
  extractionPath: z.enum(['text','vision']).optional(),  // presentational (T5b-2); every real v2 store stamps it
});

export const RunStatus = z.enum(['queued','running','completed','failed']);
export const Progress = z.object({                   // donor JobProgress shape
  stage: z.string(), current: z.number().int(), total: z.number().int(), label: z.string(),
});

export const SearchRun = z.object({
  id: z.string(), status: RunStatus, persona: Persona,
  sources: z.array(z.string()),                      // SourceRef ids in scope
  progress: Progress.nullable(),
  stats: z.object({ scanned: z.number().int(), matched: z.number().int(), scored: z.number().int(),
    worth: z.number().int(), ghosts: z.number().int(), unscored: z.number().int(),
    capStopped: z.boolean(), discoverMs: z.number().int(), scoreMs: z.number().int(),
    costUsd: z.number(), policyVersion: z.string(),
    perSource: z.array(z.object({ sourceId: z.string(), found: z.number().int(), errors: z.number().int() })).optional(),
  }),                                                 // §5 ScanStats
  startedAt: z.string().datetime(), finishedAt: z.string().datetime().nullable(),
  error: z.string().nullable(),
});

export const SummaryStripStats = z.object({          // Feed hero row (§11.8); GET /api/jobs' `stats`
  scanned: z.number().int(), worth: z.number().int(), ghosts: z.number().int(),
  flagged: z.number().int(), sinceLast: z.number().int(),
  excluded: z.number().int(),                        // hidden by any of the three feed gates; 0 when every gate is a no-op
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

export const RequirementStatus = z.enum(['met', 'buried', 'gap']);

export const CorrelationRow = z.object({
  requirement: z.string(), term: z.string(),
  kind: z.enum(['must', 'nice', 'responsibility']),
  status: RequirementStatus,
  evidence: z.string().nullable(),                    // verbatim résumé quote; non-null iff status ∈ {met, buried}
  atsPresent: z.boolean(),                             // deterministic: `term` occurs (normalized) in the résumé
  reason: z.string(), note: z.string().nullable(),
});

export const CorrelationReport = z.object({
  id: z.string(), jobId: z.string(), resumeId: z.string(),
  status: RunStatus, progress: Progress.nullable(),
  rows: z.array(CorrelationRow),
  semantic: z.object({ met: z.number().int(), buried: z.number().int(),
    gap: z.number().int(), total: z.number().int() }),
  ats: z.object({ present: z.number().int(), total: z.number().int(),
    missing: z.array(z.string()) }),
  model: z.string(), costUsd: z.number().nullable(),
  createdAt: z.string().datetime(), completedAt: z.string().datetime().nullable(),
});

export const TailoredResume = z.object({
  id: z.string(), jobId: z.string(), resumeId: z.string(), status: RunStatus,
  progress: Progress.nullable(),
  reportId: z.string().nullable(),
  atsDelta: z.object({ before: z.number().int(), after: z.number().int(), total: z.number().int() }).nullable(),   // literal ATS keyword-present counts, base résumé vs. accepted merge; total = report's term count; null until finalized / for legacy rows
  resume: Resume.omit({ id: true, rawText: true }).nullable(),   // null until completed
  diff: z.array(z.object({ section: z.string(), op: z.enum(['add','remove','modify']),
    before: z.string().optional(), after: z.string().optional(),
    reason: z.string(), requirement: z.string(),
    target: z.object({ index: z.number().int().nullable(), bulletIndex: z.number().int().nullable() }) })),
  model: z.string(), createdAt: z.string().datetime(), completedAt: z.string().datetime().nullable(),
});

export const ErrorCode = z.enum(['VALIDATION_ERROR','NOT_FOUND','CONFLICT','RUN_NOT_READY',
  'PARSE_FAILED','EXTRACTION_FAILED','UPSTREAM_LLM_ERROR','PAYLOAD_TOO_LARGE',
  'FETCH_BLOCKED','NOT_A_JOB_POSTING','RATE_LIMITED','INSUFFICIENT_CREDITS',
  'INTERNAL','UNAUTHORIZED','FORBIDDEN']);              // 15 codes
                                                       // +2, 2026-07-12 pasted-job-ingestion spec §5:
                                                       // FETCH_BLOCKED (paste ladder: web search found nothing, needsText)
                                                       // NOT_A_JOB_POSTING (terminal — the page isn't a posting, !needsText)
                                                       // INTERNAL predates this spec (generic-bug fallback in url-check's
                                                       // mapFailure and the boot-sweep markAllUnfinishedAsFailed) — carried
                                                       // over faithfully from src/types/index.ts, not part of the F7 ripple.
                                                       // +2, auth core (§1a): UNAUTHORIZED (401, no/invalid session) and
                                                       // FORBIDDEN (403, authenticated but not admin) — thrown by
                                                       // requireUser()/requireAdmin() in the route handler.
                                                       // +2, membership-credits: RATE_LIMITED (429, e.g. the client-error
                                                       // beacon's per-IP limit) and INSUFFICIENT_CREDITS (402, a debit
                                                       // blocked by the wallet — thrown as InsufficientCreditsError).

export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.unknown().optional(),                 // e.g. ZodIssue[] for VALIDATION_ERROR
  }),
});

// Auth (§1a). `.parse()` strips unknown keys by default — AuthUser/AdminUser
// never round-trip a passwordHash even if a query accidentally selected one.
export const AuthUser = z.object({
  id: z.string(), email: z.string().email(), role: z.enum(['user','admin']),
});
export const RegisterRequest = z.object({
  email: z.string().email(), password: z.string().min(8).max(200),
});
export const LoginRequest = z.object({
  email: z.string().email(), password: z.string().min(1).max(200),
});
export const SessionResponse = z.object({ user: AuthUser });

// Admin (§1b). AdminUser is the GET /api/admin/users row shape.
export const AdminUser = z.object({
  id: z.string(), email: z.string().email(), role: z.enum(['user','admin']),
  createdAt: z.string().datetime(),
  resumeCount: z.number().int(), jobCount: z.number().int(), applicationCount: z.number().int(),
  balance: z.number().int(), plan: z.enum(['standard','unlimited']),
});
export const AdminUsersResponse = z.object({ items: z.array(AdminUser) });
```

## 3. Per-endpoint I/O

Boundary rule everywhere: `Schema.parse(body)` at the route handler; `ZodError` → **422** `VALIDATION_ERROR` with `issues` in `details`. No defaults injected — a missing required field always fails loud (fintech rule).

**POST /api/resume** — `multipart/form-data` (`file`: PDF/DOCX, ≤10 MB) **or** `application/json` `{ text: z.string().min(100) }`. → `200 Resume`. Errors: `413 PAYLOAD_TOO_LARGE`, `422` (bad mime/empty text), `502 PARSE_FAILED` (unpdf/LLM extraction failed — no partial résumé is ever persisted). Idempotent-by-replacement, per user: each user holds exactly one active résumé (`resumes_user_id_active_unique`); a new upload atomically supersedes the caller's own active résumé, scoped to the session.

**GET /api/resume** — → `200 Resume` | `404 NOT_FOUND`. No `{hasResume:false}` sentinel — absence is a 404 and the kit's `hasResume` flag is derived client-side.

**GET /api/profile** — the caller's own profile (scoped by `requireUser()`'s session id). → `200 Profile` | `404 NOT_FOUND` (no row yet — the caller hasn't onboarded). **PUT /api/profile** — `Profile.omit({ updatedAt, attrProvenance })` (both server-computed), upsert (create-or-replace) keyed on `user_id` — this is the onboarding path, not just an edit route: a fresh registrant's first `PUT` creates the row instead of 404ing. → `200 Profile` | `422`.

**POST /api/search** — `{ persona: Persona, sources?: z.array(z.string()).min(1).optional() }` (omitted `sources` = persona's full configured set — an explicit empty array is a 422, not a silent all). → `202 SearchRun` (`status:'queued'`). `409 CONFLICT` if a run is already active for that persona (`details: { activeRunId }`). `409` also if no résumé exists (search scores against it).

**GET /api/search/:id** — → `200 SearchRun` | `404`. With `Accept: text/event-stream` → SSE (§4).

**GET /api/jobs** — query (all validated, unknown params rejected): `persona?`, `tier?` (repeatable), `minScore?` (0–5), `isNew?`, `q?`, `cursor?`, `limit?` (1–100, default 25). → `200 { items: Job[], nextCursor: string | null, stats: SummaryStripStats }`. `stats` is the Feed hero row's numbers (scanned/worth/ghosts/flagged/sinceLast/excluded) computed server-side over the full scoped result set, not derived client-side from the (paginated) `items` page. The feed applies **one hard gate and two rank signals, all server-derived from the profile, none wire params**: (1) the eligibility gate (2026-07-12 spec §8) — relocation `stay` admits `anywhere|eligible|local|unknown`, hiding `abroad`; `open` applies no condition; the pasted scope is exempt; (2) the `tz_band` rank signal (2026-07-14 remote-fit spec §7, as amended by DECISION A full soft rank) — `scheduleFlex` resolves to an allowed-band set via `allowedBandsFor`, and jobs whose *stated* `tz_band` falls outside it are demoted (sorted last cross-page via the SQL ORDER BY), never hidden; (3) the `hiring_structure` rank signal — `employmentPref` resolves via `allowedStructuresFor`, same demote-never-hide. For (2)/(3), a `NULL` (unstated) column is never demoted — only a *stated* fact can rank a job down. Either resolver returning `null` ("any/any-hours") means no demotion at all. `stats.excluded` counts only what gate (1) hid — 0 under relocation `open` or in the pasted scope. The former `remote?` boolean (persona-based) was removed with the "Work anywhere" chip swap (spec §2.7). `stats.excluded` deviates from the "full scoped result set" framing above in two ways: it counts every job the relocation gate hid, whether or not it has been scored yet (no `job_scores` join — a hidden-and-unscored row still counts), and it is scoped only by `persona`/`q`/`isNew`, deliberately ignoring `tier`/`minScore` (those are `job_scores` columns; this number answers "what did relocation hide," not "what would also have passed your score filters").

**Four axes — never conflate** (2026-07-12 eligibility spec §3, amended by the 2026-07-12 pasted-job-ingestion spec §2.5): `Source.persona` = scan routing (which source-set a run fans out to); `Job.persona` = run provenance ∈ {remote-run, local-run, **pasted**} (stamped at upsert, immutable on re-sight — pasting IS the provenance; this amendment locally supersedes the eligibility spec's "Persona untouched" lock on this one point, recorded in `docs/architecture/README.md`); `Job.eligibility` = posting geography relative to the operator profile (`anywhere | eligible | local | abroad | unknown`), resolved deterministically (board country stamp → JD-stated facts → connector geo → source prior → unknown) and refreshed by the scoring path. The eligibility visibility predicate does not apply in the Pasted scope (§2.12 of the pasted-job-ingestion spec) — the operator pasted the job deliberately. · schedule/structure facts = stated constraints (tz_band, hiring_structure) matched against the profile dials (scheduleFlex, employmentPref) at feed-read, never LLM-judged.

**GET /api/jobs/:id** — → `200 Job` | `404`.

**POST /api/apply/questions** — `{ jobId?, url?, pastedForm? }` with `.refine` requiring **exactly one** of the three (422 otherwise). → `200 { questions: ApplicationQuestion[], sourceUrl: string | null }`. Errors: `404` (unknown jobId), `502 EXTRACTION_FAILED` (unfetchable URL / no questions found — never returns `[]` as a guess).

**POST /api/apply/answers** — `{ jobId, questions: ApplicationQuestion[].min(1) }`. → `200 ApplicationAnswers`. `409` if no résumé; `502 UPSTREAM_LLM_ERROR`. Grounding array is required per answer — an answer the model can't ground still returns, with empty `grounding`, so the UI can flag it (visible, not silently dropped).

**PATCH /api/apply/answers/:id** — `{ answers: ApplicationAnswer[].min(1) }` (empty patch → 422). → `200 ApplicationAnswers` | `404`. Covers user edits and per-question regenerate/redraft after the initial `POST /api/apply/answers` — the assistant's Regenerate/edit actions persist through this route rather than mutating client-only state.

**POST /api/applications** — `{ jobId, note?, tailoredResumeId?, answersId? }`. → `201 Application` (server sets `appliedAt`, `stage: 0`, `statusLabel/statusTone` via `features/applied/status-map.ts`). **Idempotency: unique on `jobId`** → duplicate `409 CONFLICT` with `details: { existingId }`. `404` unknown job id; `409 CONFLICT` if the job exists but has no `job_scores` row yet (a job must be scored before it can be tracked — `Application.score` has no other source).

**GET /api/applications** — query `stage?`, `statusTone?`, `cursor?`, `limit?`. → `200 { items: Application[], nextCursor }`.

**PATCH /api/applications/:id** — partial of `{ stage, statusLabel, statusTone, note, tailored, tailoredResumeId, answersId }` (empty patch → 422). → `200 Application` | `404`.

**POST /api/tailor/correlate** — `{ jobId }`. → `202 CorrelationReport` (queued). `404` unknown job, `409` no résumé.

**GET /api/tailor/correlate/:id** — → `200 CorrelationReport` | `404`; SSE via Accept header.

**POST /api/tailor** — `{ jobId, reportId? }` (`reportId` grounds the diff in an existing `CorrelationReport`; omitted means the tailor run resolves its own). → `202 TailoredResume` (queued). `404` unknown job, `409` no résumé.

**GET /api/tailor/:id** — → `200 TailoredResume` | `404`; SSE via Accept header.

**POST /api/tailor/:id/finalize** — `{ acceptedIndices: z.array(z.number().int()) }` (indices into `TailoredResume.diff`). → `200 TailoredResume`, server-rendered with only the accepted diff entries applied (`resume` reflects the accepted-only merge, not the full-tailor draft). `404` unknown id, `409 RUN_NOT_READY` while `status !== 'completed'`. The accept/reject mask never lives only in client state — the UI's ChangeList/ExportBar accept flags are indices passed here, and `GET /api/tailor/:id/pdf` renders whatever this route last finalized.

**GET /api/tailor/:id/pdf** — → `200 application/pdf` | `404` | `409 RUN_NOT_READY` while the run hasn't been finalized (`POST .../finalize` not yet called, or `status !== 'completed'`).

**POST /api/jobs/check** — `UrlCheckRequest`. → `202 UrlCheck` (`status:'queued'` — the row is enqueued and `urlCheckWorker.kick()` is fired; the worker, not this request, owns execution — 2026-07-13 parallel-scoring spec §4.3/§4.5) | `200 UrlCheck` (completed, `alreadyKnown:true` dedupe short-circuit — no spend). `409 CONFLICT` no active résumé, checked at admission before any spend. `422 VALIDATION_ERROR` bad body/URL. `422 PAYLOAD_TOO_LARGE` pasted `text` over the 40k-char cap. Admission errors are HTTP; pipeline failures land in `UrlCheck.error`, never as an HTTP error on this route once 202/200 has been returned (2026-07-12 pasted-job-ingestion spec §5–§6).

**GET /api/jobs/check?ids=<csv>** — comma-separated `url_checks` ids. → `200 UrlChecksSnapshot` (`{ checks: UrlCheck[], paused: boolean }`) — the exact rows for the given ids, in any status; one request polls the whole queue regardless of how many runs are active, fixing the k-requests-per-tick multiplexing problem now that checks run concurrently. `UrlCheck`'s wire shape is unchanged — `attempts`/`lease_expires_at` are worker-internal DB columns, never serialized. `422 VALIDATION_ERROR` if neither `ids` nor `active=1` is given (2026-07-13 parallel-scoring spec §4.5).

**GET /api/jobs/check?active=1** — → `200 UrlChecksSnapshot` — in-flight (`queued`+`running`) rows only, used to repopulate the corner tray after a hard refresh (in-memory client ids are lost on reload; there is no server-side "recently finished" window — that was cut, it caused a stuck-card bug). `paused:true` when the worker is holding claims back on the daily cost cap (`CALIBER_DAILY_LLM_USD`) — queued rows stay queued and resume when the window resets; a cap hit never terminal-fails durable queued work (spec §4.7–§4.8).

**GET /api/jobs/check/:id** — → `200 UrlCheck` | `404`. Poll ~1.5s; `UrlCheck.stage` is an open string (`fetching|searching|extracting|persisting|ghost-check|scoring`). Kept for deep links — the batched `?ids=`/`?active=1` routes above are what the feed/dock actually poll on a shared interval.

**DELETE /api/jobs/:id** — → `204` | `404` unknown job | `409 CONFLICT` `persona !== 'pasted'` | `409 CONFLICT` a tracked `applications` row exists ("tracked application — deletion blocked" — the lifelong-tracker promise wins over deletion). One transaction deletes `application_answers` → `tailored_resumes` → `correlation_reports` → `job_scores` for the job, then the `jobs` row (`correlation_reports` runs after `tailored_resumes` since `tailored_resumes.report_id` FKs it); `url_checks.job_id` nulls via `ON DELETE SET NULL` (spec §10).

## 4. Streaming (SSE)

The three run endpoints (search, tailor, correlate) emit the same envelope; every `data:` payload is schema-validated JSON, and events carry monotonic `id:` for `Last-Event-ID` resume:

```ts
// M2 concurrency-lane observability events (2026-07-15 scan-observability
// spec) — SourceEventData is one source connector's fetch status, JobPhaseData
// is one in-flight scoring job's sub-phase, ScanFrame is the periodic
// full-state snapshot (all three are search-only, like `job`).
export const SourceEventData = z.object({
  sourceId: z.string(), name: z.string(), status: z.enum(['fetching','done','error']),
  found: z.number().int().optional(), error: z.string().optional(),
});
export const JobPhaseData = z.object({
  jobId: z.string(), title: z.string(), company: z.string(), source: z.string(),
  phase: z.enum(['fetching','readingJD','scoring','rescoring','done','error']),
  verdict: z.enum(['Apply','Consider','Research first','Skip']).optional(),
  legitimacyTier: LegitimacyTier.optional(), fit: z.number().min(0).max(5).optional(),
});
export const ScanFrame = z.object({
  sources: z.array(SourceEventData), activeJobs: z.array(JobPhaseData),
  counts: z.object({ scored: z.number().int(), queued: z.number().int(), total: z.number().int() }),
});

// event: progress → Progress   e.g. {stage:'boards', current:3, total:7, label:'Scanning Hiredly…'}
// event: job      → Job              (search only: scored job streamed into the feed as found)
// event: source   → SourceEventData  (M2: per-source discover status)
// event: jobPhase → JobPhaseData     (M2: one in-flight scoring job's sub-phase)
// event: snapshot → ScanFrame        (M2: periodic full concurrency-lane snapshot)
// event: done     → SearchRun | TailoredResume   (terminal snapshot, then close)
// event: error    → ErrorEnvelope                (terminal, then close)
export const SseEvent = z.discriminatedUnion('event', [
  z.object({ event: z.literal('progress'), data: Progress }),
  z.object({ event: z.literal('job'),      data: Job }),
  z.object({ event: z.literal('source'),   data: SourceEventData }),
  z.object({ event: z.literal('jobPhase'), data: JobPhaseData }),
  z.object({ event: z.literal('snapshot'), data: ScanFrame }),
  z.object({ event: z.literal('done'),     data: z.union([SearchRun, TailoredResume]) }),
  z.object({ event: z.literal('error'),    data: ErrorEnvelope }),
]);
```

`stage` values — search: `sources → fetch → score → legitimacy → done`; tailor: `correlate → rewrite → render → done`; correlate: `extract → classify → verify → done`. Donor `JobProgress` shape, so ScanProgress binds unchanged.

## 5. OpenAPI & typed client

- **Schemas** live co-located with the frozen contract in `src/types/*.ts` — one Zod object per entity/request/response, exported alongside `z.infer` types. Server, routes, and UI import these; no second type system.
- **Contract module** `src/contract/`: `registry.ts` registers every schema + path with `@asteasolutions/zod-to-openapi` (both JSON and `text/event-stream` on the run GETs); `generate.ts` (via `npm run contract`) emits `contract/openapi.json`, committed and diffed in PRs.
- **Docs**: `contract/openapi.json` served through a Scalar page at `/api/docs`.
- **Typed client**: internally none generated — one Next.js codebase, so `features/*` fetch wrappers take/return `z.infer` types and `.parse` responses in dev/test (catching drift at runtime). OpenAPI exists for docs and future external codegen.

Sources are real (`GET /api/sources` → `{ items: Source[] }`, `PATCH /api/sources/:id` `{enabled}` → `Source`; `/sources` page). Deferred (out of this contract): cover letters, interviews, insights, notifications — same run/entity patterns when their screens are wired (Phases C–D).
