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

export const Tone = z.enum(["verified", "good", "warn", "ghost", "danger"]);
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

// Remote-fit dials + stated-fact enums (spec 2026-07-14-remote-fit-criteria-design.md §3).
// ScheduleFlex is ORDERED (base-hours < flex-evenings < any-hours); higher includes lower.
export const ScheduleFlex = z.enum(["base-hours", "flex-evenings", "any-hours"]);
export type ScheduleFlex = z.infer<typeof ScheduleFlex>;
// employee = local entity OR EOR; local-entity = local entity only.
export const EmploymentPref = z.enum(["any", "employee", "local-entity"]);
export type EmploymentPref = z.infer<typeof EmploymentPref>;
// Job-side stated facts (jobs.tz_band, jobs.hiring_structure). NULL in the DB = nothing stated.
export const TzBand = z.enum(["apac", "emea", "americas"]);
export type TzBand = z.infer<typeof TzBand>;
export const HiringStructure = z.enum(["local-entity", "eor", "contractor"]);
export type HiringStructure = z.infer<typeof HiringStructure>;

// Operator profile — singleton (single-operator MVP). `baseCountry` is
// ISO-3166-1 alpha-2 ("MY" at launch). The seed row IS the install step
// (seed.ts precedent); a missing row is an error, never defaulted.
export const Profile = z.object({
  baseCountry: z.string().length(2),
  relocation: RelocationPref,
  scheduleFlex: ScheduleFlex, // NEW (spec 2026-07-14 §3)
  employmentPref: EmploymentPref, // NEW (spec 2026-07-14 §3)
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
  tags: z.array(z.object({ tone: Tone, label: z.string() })),
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
  summary: z.string(),
  experience: z.array(
    z.object({ title: z.string(), company: z.string(), dates: z.string(), bullets: z.array(z.string()) }),
  ),
  skills: z.array(z.string()),
  rawText: z.string(), // parse provenance, grounds F4/F6
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

export const SearchRun = z.object({
  id: z.string(),
  status: RunStatus,
  persona: Persona,
  sources: z.array(z.string()), // SourceRef ids in scope
  progress: Progress.nullable(),
  stats: z.object({
    scanned: z.number().int(),
    worth: z.number().int(),
    ghosts: z.number().int(),
  }), // §5 ScanStats, feeds summary strip
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  error: z.string().nullable(),
});
export type SearchRun = z.infer<typeof SearchRun>;

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

export const TailoredResume = z.object({
  id: z.string(),
  jobId: z.string(),
  resumeId: z.string(),
  status: RunStatus,
  progress: Progress.nullable(),
  resume: Resume.omit({ id: true, rawText: true }).nullable(), // null until completed
  diff: z.array(
    z.object({
      section: z.string(),
      op: z.enum(["add", "remove", "modify"]),
      before: z.string().optional(),
      after: z.string().optional(),
      reason: z.string(),
    }),
  ),
  model: z.string(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});
export type TailoredResume = z.infer<typeof TailoredResume>;

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
  "INTERNAL",
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

// SSE envelope for the two run endpoints (api-contract.md §4). Verbatim
// discriminated union: `progress` streams as the run advances, `job` is
// search-only (a scored job — not emitted by B5's discovery-only slice),
// `done`/`error` are terminal (stream closes after either).
export const SseEvent = z.discriminatedUnion("event", [
  z.object({ event: z.literal("progress"), data: Progress }),
  z.object({ event: z.literal("job"), data: Job }),
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
  excluded: z.number().int(), // hidden by the eligibility predicate (spec §8) — 0 under relocation "open"
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
