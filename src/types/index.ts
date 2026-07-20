// Caliber contract types — Zod schemas are the single source of truth.
// Verbatim from docs/architecture/api-contract.md §2. Everything (fixtures,
// compositions, future server routes) imports from here; nothing redeclares
// these shapes. `Schema.parse(...)` at every boundary — no silent defaults.
import { z } from "zod";

export const Persona = z.enum(["remote", "local", "pasted"]);
export type Persona = z.infer<typeof Persona>;

export const ScanPersona = z.enum(["remote", "local"]);
export type ScanPersona = z.infer<typeof ScanPersona>;

export const LegitimacyTier = z.enum(["verified", "clear", "suspicious", "ghost", "scam"]); // §11.8
export type LegitimacyTier = z.infer<typeof LegitimacyTier>;

export const Tone = z.enum(["verified", "good", "warn", "ghost", "danger", "neutral"]);
export type Tone = z.infer<typeof Tone>;

export const GhostWebEvidence = z.object({
  sightings: z.array(
    z.object({
      url: z.string().url(), // the citation IS the sighting
      source: z.string(),
      postedDate: z.string().optional(),
    }),
  ),
  companySignals: z.array(z.string()),
  summary: z.string(),
  confidence: z.number().min(0).max(1),
});
export type GhostWebEvidence = z.infer<typeof GhostWebEvidence>;

export const WebEvidence = z.discriminatedUnion("status", [
  GhostWebEvidence.extend({ status: z.literal("ok") }),
  z.object({ status: z.literal("failed"), reason: z.string() }),
]);
export type WebEvidence = z.infer<typeof WebEvidence>;

export const Legitimacy = z.object({
  tier: LegitimacyTier,
  tone: Tone,
  summary: z.string(),
  confidence: z.number().min(0).max(1).optional(), // only if scorer emits a real number (§11.8 D/G)
  webEvidence: WebEvidence.optional(),
});
export type Legitimacy = z.infer<typeof Legitimacy>;

// Eligibility — posting geography relative to the operator profile (spec
// 2026-07-12-remote-local-eligibility-design.md §3). Third axis, distinct
// from Source.persona (scan routing) and Job.persona (run provenance).
export const EligibilityTier = z.enum(["anywhere", "eligible", "local", "abroad", "unknown"]);
export type EligibilityTier = z.infer<typeof EligibilityTier>;

export const Eligibility = z.object({
  tier: EligibilityTier,
  tone: Tone,
  summary: z.string(), // the resolver's evidence string
});
export type Eligibility = z.infer<typeof Eligibility>;

export const SourceRef = z.object({ // Source entity, referenced from Job
  id: z.string(),
  name: z.string(),
  kind: z.enum(["ats", "board", "manual"]),
  persona: Persona,
});
export type SourceRef = z.infer<typeof SourceRef>;

// Full source row for the Sources management page — includes disabled rows
// and the DB-only "both" persona (SourceRef stays the slim per-job ref).
export const Source = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["ats", "board", "manual"]),
  persona: z.enum(["remote", "local", "both"]),
  enabled: z.boolean(),
});
export type Source = z.infer<typeof Source>;

export const RelocationPref = z.enum(["stay", "open"]);
export type RelocationPref = z.infer<typeof RelocationPref>;

export const ScheduleFlex = z.enum(["base-hours", "flex-evenings", "any-hours"]); // ordered: each level includes the ones before it
export type ScheduleFlex = z.infer<typeof ScheduleFlex>;

export const EmploymentPref = z.enum(["any", "employee", "local-entity"]); // "employee" admits local entity OR EOR
export type EmploymentPref = z.infer<typeof EmploymentPref>;

// TzBand/HiringStructure — shared vocabulary for resolveTzBand + the schedule/
// structure gates, NOT wire fields (spec §3: zero new Job fields; the jobs.tz_band/
// hiring_structure columns are DB-only). Bare TS types, no Zod — never add to a
// wire schema.
export type TzBand = "apac" | "emea" | "americas";
export type HiringStructure = "local-entity" | "eor" | "contractor";

// Operator profile — singleton (single-operator MVP). `baseCountry` is
// ISO-3166-1 alpha-2 ("MY" at launch). The seed row IS the install step
// (seed.ts precedent); a missing row is an error, never defaulted.
export const Profile = z.object({
  baseCountry: z.string().length(2),
  relocation: RelocationPref,
  scheduleFlex: ScheduleFlex,
  employmentPref: EmploymentPref,
  updatedAt: z.string().datetime(),
});
export type Profile = z.infer<typeof Profile>;

export const Job = z.object({ // §5 frozen + §11.8 extensions
  id: z.string(),
  score: z.number().min(0).max(5),
  ghost: z.boolean().optional(),
  role: z.string(),
  company: z.string(),
  meta: z.string(),
  verdict: z.string(),
  why: z.string(),
  tags: z.array(z.object({ tone: Tone, label: z.string(), title: z.string().optional() })),
  breakdown: z.array(
    z.object({
      label: z.string(),
      value: z.number(),
      display: z.string().optional(),
      tone: Tone.optional(),
    }),
  ),
  fit: z.array(z.object({ k: z.string(), v: z.string() })),
  gaps: z.array(z.object({ tone: z.enum(["warn", "ok"]), k: z.string(), v: z.string() })),
  legitimacy: Legitimacy,
  eligibility: Eligibility, // posting geography vs profile (spec 2026-07-12 §3)
  applyUrl: z.string().url(), // F3: the canonical posting URL
  source: SourceRef,
  persona: Persona,
  firstSeen: z.string().datetime(),
  isNew: z.boolean(),
});
export type Job = z.infer<typeof Job>;

export const Resume = z.object({ // §5; `hasResume` is NOT a field — absence = 404
  id: z.string(),
  atsScore: z.number().int().min(0).max(100),
  updatedAt: z.string().datetime(), // wire form of kit's `updated`; UI derives "3d ago"
  headline: z.string(),
  location: z.string(),
  summary: z.string().optional(),
  experience: z.array(
    z.object({ title: z.string(), company: z.string(), dates: z.string(), bullets: z.array(z.string()) }),
  ),
  skills: z.array(z.string()),
  projects: z.array(z.object({ name: z.string(), url: z.string().optional(), bullets: z.array(z.string()) })),
  certifications: z.array(z.object({ name: z.string(), issuer: z.string().optional(), year: z.string().optional() })),
  languages: z.array(z.object({ language: z.string(), proficiency: z.string().optional() })),
  rawText: z.string(), // parse provenance, grounds F4/F6
  extractionPath: z.enum(["text", "vision"]).optional(), // presentational (T5b-2); optional for fixture convenience — every real v2 store stamps it; promote to required at the next contract revision
});
export type Resume = z.infer<typeof Resume>;

export const RunStatus = z.enum(["queued", "running", "completed", "failed"]);
export type RunStatus = z.infer<typeof RunStatus>;

export const Progress = z.object({ // donor JobProgress shape
  stage: z.string(),
  current: z.number().int(),
  total: z.number().int(),
  label: z.string(),
});
export type Progress = z.infer<typeof Progress>;

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
  // Per-source discover breakdown (spec §4.3). Optional on the wire only for
  // fixture convenience — the assemblers always supply it (`?? []` for legacy rows).
  perSource: z.array(z.object({ sourceId: z.string(), found: z.number().int(), errors: z.number().int() })).optional(),
});
export type ScanStats = z.infer<typeof ScanStats>;

export const SearchRun = z.object({
  id: z.string(),
  status: RunStatus,
  persona: Persona,
  sources: z.array(z.string()), // SourceRef ids in scope
  progress: Progress.nullable(),
  stats: ScanStats, // §5 ScanStats, feeds summary strip
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  error: z.string().nullable(),
});
export type SearchRun = z.infer<typeof SearchRun>;

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
  reason: z.enum(["dailyCap", "alreadyScored"]).optional(), // only when outcome === "skipped"
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

export const Application = z.object({ // §5 Applied, wire-normalised
  id: z.string(),
  jobId: z.string(),
  role: z.string(),
  company: z.string(),
  meta: z.string(),
  appliedAt: z.string().datetime(), // `appliedAgo` derived client-side
  score: z.number().min(0).max(5),
  stage: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]), // Applied→Screen→Interview→Decision
  statusLabel: z.string(),
  statusTone: z.enum(["good", "verified", "neutral"]), // neutral = closed
  tailored: z.boolean(),
  note: z.string(),
  tailoredResumeId: z.string().nullable(),
  answersId: z.string().nullable(),
});
export type Application = z.infer<typeof Application>;

export const ApplicationQuestion = z.object({
  id: z.string(),
  prompt: z.string(),
  kind: z.enum(["text", "textarea", "select", "multiselect", "boolean", "file"]),
  options: z.array(z.string()).optional(), // required iff kind is (multi)select
  required: z.boolean(),
  maxLength: z.number().int().optional(),
});
export type ApplicationQuestion = z.infer<typeof ApplicationQuestion>;

export const ApplicationAnswer = z.object({
  questionId: z.string(),
  prompt: z.string(),
  answer: z.string(),
  grounding: z.array(
    z.object({
      source: z.enum(["experience", "skills", "summary", "headline"]),
      quote: z.string(),
    }),
  ), // every claim traces to the résumé
});
export type ApplicationAnswer = z.infer<typeof ApplicationAnswer>;

export const ApplicationAnswers = z.object({ // persisted set entity
  id: z.string(),
  jobId: z.string(),
  resumeId: z.string(),
  answers: z.array(ApplicationAnswer),
  model: z.string(),
  createdAt: z.string().datetime(),
});
export type ApplicationAnswers = z.infer<typeof ApplicationAnswers>;

export const RequirementStatus = z.enum(["met", "buried", "gap"]);

export const CorrelationRow = z.object({
  requirement: z.string(),
  term: z.string(),
  kind: z.enum(["must", "nice", "responsibility"]),
  status: RequirementStatus,
  evidence: z.string().nullable(),   // verbatim résumé quote; non-null iff status ∈ {met, buried}
  atsPresent: z.boolean(),           // deterministic: `term` occurs (normalized) in the résumé
  reason: z.string(),
  note: z.string().nullable(),
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
export type CorrelationReport = z.infer<typeof CorrelationReport>;
export type CorrelationRow = z.infer<typeof CorrelationRow>;

export const TailoredResume = z.object({
  id: z.string(), jobId: z.string(), resumeId: z.string(), status: RunStatus,
  progress: Progress.nullable(),
  reportId: z.string().nullable(),
  atsDelta: z
    .object({ before: z.number().int(), after: z.number().int(), total: z.number().int() })
    .nullable(),
  resume: Resume.omit({ id: true, rawText: true }).nullable(),
  diff: z.array(z.object({
    section: z.string(), op: z.enum(["add", "remove", "modify"]),
    before: z.string().optional(), after: z.string().optional(),
    reason: z.string(), requirement: z.string(),
    target: z.object({ index: z.number().int().nullable(),
      bulletIndex: z.number().int().nullable() }),
  })),
  model: z.string(), createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});
export type TailoredResume = z.infer<typeof TailoredResume>;
export type TailorDiffEntry = z.infer<typeof TailoredResume>["diff"][number];

export const ErrorCode = z.enum([
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "CONFLICT",
  "RUN_NOT_READY",
  "PARSE_FAILED",
  "EXTRACTION_FAILED",
  "UPSTREAM_LLM_ERROR",
  "PAYLOAD_TOO_LARGE",
  "FETCH_BLOCKED",
  "NOT_A_JOB_POSTING",
  "RATE_LIMITED",
  "INSUFFICIENT_CREDITS",
  "INTERNAL",
  "UNAUTHORIZED",
  "FORBIDDEN",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.unknown().optional(), // e.g. ZodIssue[] for VALIDATION_ERROR
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

export const SourceEventData = z.object({
  sourceId: z.string(),
  name: z.string(),
  status: z.enum(["fetching", "done", "error"]),
  found: z.number().int().optional(),
  error: z.string().optional(),
});
export type SourceEventData = z.infer<typeof SourceEventData>;

export const JobPhaseData = z.object({
  jobId: z.string(),
  title: z.string(),
  company: z.string(),
  source: z.string(),
  phase: z.enum(["fetching", "readingJD", "scoring", "rescoring", "done", "error"]),
  verdict: z.enum(["Apply", "Consider", "Research first", "Skip"]).optional(),
  legitimacyTier: LegitimacyTier.optional(),
  fit: z.number().min(0).max(5).optional(),
});
export type JobPhaseData = z.infer<typeof JobPhaseData>;

export const ScanFrame = z.object({
  sources: z.array(SourceEventData),
  activeJobs: z.array(JobPhaseData),
  counts: z.object({ scored: z.number().int(), queued: z.number().int(), total: z.number().int() }),
});
export type ScanFrame = z.infer<typeof ScanFrame>;

// SSE envelope for the two run endpoints (api-contract.md §4). Verbatim
// discriminated union: `progress` streams as the run advances, `job` is
// search-only (a scored job — not emitted by B5's discovery-only slice),
// `source`/`jobPhase`/`snapshot` are M2 concurrency-lane observability
// events, `done`/`error` are terminal (stream closes after either).
export const SseEvent = z.discriminatedUnion("event", [
  z.object({ event: z.literal("progress"), data: Progress }),
  z.object({ event: z.literal("job"), data: Job }),
  z.object({ event: z.literal("source"), data: SourceEventData }),
  z.object({ event: z.literal("jobPhase"), data: JobPhaseData }),
  z.object({ event: z.literal("snapshot"), data: ScanFrame }),
  z.object({ event: z.literal("done"), data: z.union([SearchRun, TailoredResume]) }),
  z.object({ event: z.literal("error"), data: ErrorEnvelope }),
]);
export type SseEvent = z.infer<typeof SseEvent>;

// SummaryStripStats — the Feed hero stat row (§11.8): scanned/worth/ghosts
// mirror SearchRun's scan stats, `flagged`/`sinceLast` are the two Feed-only
// additions. `GET /api/jobs` returns this alongside the page of jobs so
// JobFeed never derives it client-side from the (paginated) `items` array.
export const SummaryStripStats = z.object({
  scanned: z.number().int(),
  worth: z.number().int(),
  ghosts: z.number().int(),
  flagged: z.number().int(),
  sinceLast: z.number().int(),
  excluded: z.number().int(), // hidden by any of the three feed gates (eligibility/schedule/structure, spec §8) — 0 when every gate is a no-op
});
export type SummaryStripStats = z.infer<typeof SummaryStripStats>;

export const UrlCheckRequest = z.object({
  url: z.string().url(), // applyUrl + dedupe key (dedupeKeyFor throws on bad URLs)
  text: z.string().min(1).optional(), // paste-text fallback; skips fetch/search tiers
});
export type UrlCheckRequest = z.infer<typeof UrlCheckRequest>;

export const UrlCheck = z.object({
  id: z.string().uuid(),
  url: z.string().url(),
  status: RunStatus,
  stage: z.string().nullable(), // open string — Progress.stage precedent
  jobId: z.string().uuid().nullable(),
  alreadyKnown: z.boolean(),
  needsText: z.boolean(), // true ⇔ failure recoverable by pasting JD text
  error: z.object({ code: ErrorCode, message: z.string() }).nullable(),
  createdAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
});
export type UrlCheck = z.infer<typeof UrlCheck>;

export const UrlChecksSnapshot = z.object({
  checks: z.array(UrlCheck),
  paused: z.boolean(), // true ⇔ worker is holding claims on the daily cost cap
});
export type UrlChecksSnapshot = z.infer<typeof UrlChecksSnapshot>;

export const AuthUser = z.object({
  id: z.string(),
  email: z.string().email(),
  role: z.enum(["user", "admin"]),
}); // .parse() strips unknown keys (e.g. passwordHash) by default
export type AuthUser = z.infer<typeof AuthUser>;

export const CreditsResponse = z.object({ balance: z.number().int(), plan: z.enum(["standard", "unlimited"]) });
export type CreditsResponse = z.infer<typeof CreditsResponse>;

export const RegisterRequest = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  inviteCode: z.string().min(1),
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const LoginRequest = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

// ChangePasswordRequest — PATCH /api/auth/password body (Task 6, Decision 2).
// The route reverifies currentPassword server-side before rehashing.
export const ChangePasswordRequest = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(200),
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

export const SessionResponse = z.object({ user: AuthUser });
export type SessionResponse = z.infer<typeof SessionResponse>;

// AdminUser — GET /api/admin/users row shape. `.parse()` strips unknown keys
// (e.g. passwordHash) by default, same as AuthUser above — never add a hash
// field to this schema.
export const AdminUser = z.object({
  id: z.string(),
  email: z.string().email(),
  role: z.enum(["user", "admin"]),
  createdAt: z.string().datetime(),
  resumeCount: z.number().int(),
  jobCount: z.number().int(),
  applicationCount: z.number().int(),
  balance: z.number().int(),
  plan: z.enum(["standard", "unlimited"]),
});
export type AdminUser = z.infer<typeof AdminUser>;

export const AdminUsersResponse = z.object({ items: z.array(AdminUser) });
export type AdminUsersResponse = z.infer<typeof AdminUsersResponse>;

// AdminPlanPatch — PATCH /api/admin/users/:id body (admin plan toggle).
export const AdminPlanPatch = z.object({ plan: z.enum(["standard", "unlimited"]) });
export type AdminPlanPatch = z.infer<typeof AdminPlanPatch>;

// AdminGrantRequest — POST /api/admin/users/:id/credits body (admin credit
// grant, ±delta). Zero is meaningless as a grant, so it's rejected here.
export const AdminGrantRequest = z.object({ delta: z.number().int().refine((n) => n !== 0) });
export type AdminGrantRequest = z.infer<typeof AdminGrantRequest>;

// SourceHealthRow / SourcesHealthResponse — GET /api/admin/sources (Track O
// task O.2, spec §4.3: dead/disabled sources "visibly disabled with a count
// on an admin surface"). Only engine-seeded rows (freshness.ts) carry the
// health fields below; hand-curated seed.ts rows have none of them — the
// fields are optional here for exactly that reason (an absent field is a
// curated row, not a failure).
export const SourceHealthRow = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  status: z.enum(["active", "dead"]).optional(),
  consecutiveFailures: z.number().int().optional(),
  lastValidatedAt: z.number().int().optional(),
  jobCount: z.number().int().optional(),
  provenance: z.array(z.string()).optional(),
  // Set when an engine row's health config is malformed — surfaced in the
  // admin list, not fatal; mirrors freshness.ts's row-level failure.
  error: z.string().optional(),
});
export type SourceHealthRow = z.infer<typeof SourceHealthRow>;

export const SourcesHealthResponse = z.object({
  total: z.number().int(),
  enabledCount: z.number().int(),
  deadCount: z.number().int(),
  items: z.array(SourceHealthRow),
});
export type SourcesHealthResponse = z.infer<typeof SourcesHealthResponse>;

// AdminCrawlStatus — GET /api/admin/crawl (Crawl status panel, spec
// 2026-07-17: the operator's live view of the global postings pool). Mirrors
// SourcesHealthResponse's degrade philosophy: `pool`/`staleness`/`lastRuns`/
// `perSource` are each independently computed, so a failing sub-query nulls
// just that section and appends to `errors` rather than 500ing the route.
// `staleness`'s own null ("no crawl has ever completed") is a legitimate
// value, not an error — `errors` is how a caller tells the two apart.
export const CrawlPoolStatus = z.object({
  live: z.number().int(),
  delisted: z.number().int(),
  total: z.number().int(),
});
export type CrawlPoolStatus = z.infer<typeof CrawlPoolStatus>;

export const CrawlRunningStatus = z.object({
  startedAt: z.string().datetime(),
  postingsSeenThisRun: z.number().int(),
  sourcesWrittenThisRun: z.number().int(),
});
export type CrawlRunningStatus = z.infer<typeof CrawlRunningStatus>;

// `skipped` = enabledCrawlableSources − (sourcesOk + sourcesFailed), computed
// against the CURRENT sources table (not a historical snapshot) — the single
// most important derived number here: a 429-stopped host leaves a run
// "completed" while whole boards were silently skipped.
export const CrawlRunSummary = z.object({
  status: z.enum(["completed", "failed"]),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  durationMs: z.number().int(),
  sourcesOk: z.number().int(),
  sourcesFailed: z.number().int(),
  skipped: z.number().int(),
  upserts: z.number().int(),
  delists: z.number().int(),
  perHostBackoffs: z.record(z.string(), z.number().int()),
  emptyFetches: z.array(z.string()),
});
export type CrawlRunSummary = z.infer<typeof CrawlRunSummary>;

export const CrawlSourceRow = z.object({
  sourceId: z.string(),
  name: z.string(),
  liveCount: z.number().int(),
  lastSeenAt: z.string().datetime().nullable(),
});
export type CrawlSourceRow = z.infer<typeof CrawlSourceRow>;

export const AdminCrawlStatus = z.object({
  pool: CrawlPoolStatus.nullable(),
  staleness: z.number().nullable(),
  runningCrawl: CrawlRunningStatus.nullable(),
  lastRuns: z.array(CrawlRunSummary).nullable(),
  perSource: z.object({ items: z.array(CrawlSourceRow), totalSources: z.number().int() }).nullable(),
  errors: z.array(z.string()),
});
export type AdminCrawlStatus = z.infer<typeof AdminCrawlStatus>;

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

// ClientErrorReport — POST /api/client-error crash-beacon body (pre-launch
// hardening Task 4). userId is NEVER part of this schema — the route attaches
// it server-side from the session; a client-supplied id would be spoofable.
export const ClientErrorReport = z.object({
  message: z.string().min(1).max(2000),
  stack: z.string().max(8000).optional(),
  url: z.string().max(2000),
  digest: z.string().max(200).optional(), // Next's server-component error digest when present
  at: z.string().datetime(),
});
export type ClientErrorReport = z.infer<typeof ClientErrorReport>;
