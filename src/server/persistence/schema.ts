// Drizzle sqlite-core schema (2026-07-16 sqlite migration) — the 8 tables per
// docs/architecture/system-architecture.md §1, with the 4 src/types-wins
// reconciliations from .superpowers/sdd/task-B1-brief.md applied
// (search_runs.status / tailored_resumes.status+finalizedAt / tailored_resumes.diff /
// application_answers shape+resumeId). libsql everywhere — see db.ts (real
// client) / test-db.ts (temp-file libsql test client).
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { ResumeStore } from "../resume/resume-store";
import type { ScanResult, WebEvidence } from "@/types";

// ---- shared jsonb shapes (only where a precise contract shape exists) ----

export type { ResumeStore };

export type JobAlias = { sourceId: string; url: string };

type BreakdownEntry = { label: string; value: number; display?: string; tone?: string };
type FitEntry = { k: string; v: string };
type GapEntry = { tone: "warn" | "ok"; k: string; v: string };
type ReasonsShape = { for: string[]; against: string[] };
type LegitimacyShape = {
  tier: "verified" | "clear" | "suspicious" | "ghost" | "scam";
  tone: "verified" | "good" | "warn" | "ghost" | "danger";
  summary: string;
  confidence?: number;
  signals: unknown[];
  // spec 2026-07-12-pasted-job-ingestion-design.md §6/§10 — pasted-path
  // ghost-web evidence, persisted alongside the tier it fed into the
  // overlay. Absent for scanned jobs.
  webEvidence?: WebEvidence;
};

type PerSourceStat = { sourceId: string; found: number; errors: number };
type SearchRunStats = {
  scanned: number;
  matched: number;
  scored: number;
  worth: number; // B6 addition: Apply/Consider verdict count, feeds toSearchRun's stats.worth
  ghosts: number;
  perSource: PerSourceStat[];
  unscored?: number; // B6 fix pass: jobs skipped for a null/empty description, never fabricated
  capStopped?: boolean; // B6 fix pass: true iff dailyCapUsd cut scoring short (distinct from candidates-exhausted)
  // M1 additions — real stage durations (ms) + accumulated cost + scoring policy id.
  discoverMs?: number;
  scoreMs?: number;
  costUsd?: number;
  policyVersion?: string;
};

type ApplicationAnswerEntry = {
  questionId: string;
  prompt: string;
  answer: string;
  grounding: { source: "experience" | "skills" | "summary" | "headline"; quote: string }[];
};

type TailoredResumeDiffEntry = {
  section: string;
  op: "add" | "remove" | "modify";
  before?: string;
  after?: string;
  reason: string;
  requirement: string; // the CorrelationRow.requirement this edit serves
  target: { index: number | null; bulletIndex: number | null };
};

type CorrelationReportRowJson = {
  requirement: string; term: string; kind: "must" | "nice" | "responsibility";
  status: "met" | "buried" | "gap"; evidence: string | null; atsPresent: boolean;
  reason: string; note: string | null;
};

// ---- tables ----

export const sources = sqliteTable("sources", {
  id: text("id").primaryKey(), // natural key: 'greenhouse' | 'lever' | 'ashby' | 'jobstreet' | ...
  name: text("name").notNull(), // display label for Job.source.name (SourceRef) — B6 addition, no prior home
  kind: text("kind", { enum: ["ats", "board", "manual"] }).notNull(),
  persona: text("persona", { enum: ["remote", "local", "both"] }).notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  config: text("config", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

// Operator profile — singleton row, id is the constant "default". Seeded by
// seed.ts (the seed is the install step); repos/profile.ts throws
// ProfileMissingError when absent — no runtime default.
export const profile = sqliteTable(
  "profile",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    baseCountry: text("base_country").notNull(),
    relocation: text("relocation", { enum: ["stay", "open"] }).notNull(),
    scheduleFlex: text("schedule_flex", { enum: ["base-hours", "flex-evenings", "any-hours"] }).notNull(),
    employmentPref: text("employment_pref", { enum: ["any", "employee", "local-entity"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [unique("profile_user_id_unique").on(table.userId)],
);

export const resumes = sqliteTable(
  "resumes",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull().references(() => users.id),
    rawText: text("raw_text").notNull(),
    structured: text("structured", { mode: "json" }).$type<ResumeStore>().notNull(),
    originalPath: text("original_path"),
    label: text("label"),
    sourceKind: text("source_kind", { enum: ["pdf", "docx", "paste"] }).notNull(),
    atsScore: real("ats_score"),
    isActive: integer("is_active", { mode: "boolean" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("resumes_user_id_active_unique").on(table.userId).where(sql`${table.isActive}`)],
);

export const searchRuns = sqliteTable("search_runs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id),
  resumeId: text("resume_id").notNull().references(() => resumes.id),
  personas: text("personas", { mode: "json" }).$type<("remote" | "local")[]>().notNull(),
  status: text("status", { enum: ["queued", "running", "completed", "failed"] }).notNull(), // reconciliation 1
  stats: text("stats", { mode: "json" }).$type<SearchRunStats>().notNull(),
  results: text("results", { mode: "json" }).$type<ScanResult[]>().notNull().$defaultFn(() => []),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  error: text("error"),
});

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull().references(() => users.id),
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
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    persona: text("persona", { enum: ["remote", "local", "pasted"] }).notNull(),
    // Spec 2026-07-12 §4: eligibility tier relative to the profile, stamped at
    // ingest (Layers A+B), refreshed by the scoring path (Layer C). Facts stay
    // in `raw` + job_scores.jd_facts — the tier is recomputable, pure, no LLM.
    eligibility: text("eligibility", { enum: ["anywhere", "eligible", "local", "abroad", "unknown"] }).notNull(),
    eligibilityEvidence: text("eligibility_evidence").notNull(),
    aliases: text("aliases", { mode: "json" }).$type<JobAlias[]>().notNull(),
    raw: text("raw", { mode: "json" }).$type<unknown>().notNull(),
    // Spec 2026-07-14 §6: stated remote-fit facts. NULL = nothing stated (never
    // hidden by the schedule/structure gate). tz_band is normalized from a
    // stated TZ requirement (resolveTzBand); hiring_structure is stated-only.
    tzBand: text("tz_band", { enum: ["apac", "emea", "americas"] }),
    hiringStructure: text("hiring_structure", { enum: ["local-entity", "eor", "contractor"] }),
  },
  (table) => [
    unique("jobs_user_id_dedupe_key_unique").on(table.userId, table.dedupeKey),
    // perf/scan-overhead: covers the feed's filter+sort path (listScored/
    // statsForQuery WHERE user_id = ? ORDER BY first_seen_at DESC).
    index("jobs_user_id_first_seen_at_idx").on(table.userId, table.firstSeenAt),
  ],
);

export const jobScores = sqliteTable(
  "job_scores",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull().references(() => users.id),
    jobId: text("job_id").notNull().references(() => jobs.id),
    resumeId: text("resume_id").notNull().references(() => resumes.id),
    score: real("score").notNull(),
    verdict: text("verdict", { enum: ["Apply", "Consider", "Research first", "Skip"] }).notNull(),
    why: text("why").notNull(), // frozen Job.why — one-line rationale, part of EvalScores model output (B6 addition)
    legitimacy: text("legitimacy", { mode: "json" }).$type<LegitimacyShape>().notNull(),
    liveness: text("liveness", { enum: ["active", "expired", "uncertain"] }).notNull(),
    breakdown: text("breakdown", { mode: "json" }).$type<BreakdownEntry[]>().notNull(),
    reasons: text("reasons", { mode: "json" }).$type<ReasonsShape>().notNull(),
    fit: text("fit", { mode: "json" }).$type<FitEntry[]>().notNull(),
    gaps: text("gaps", { mode: "json" }).$type<GapEntry[]>().notNull(),
    jdFacts: text("jd_facts", { mode: "json" }).$type<unknown>().notNull(),
    model: text("model").notNull(),
    escalated: integer("escalated", { mode: "boolean" }).notNull(),
    costUsd: real("cost_usd").notNull(),
    policyVersion: text("policy_version").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    unique("job_scores_job_resume_policy_unique").on(table.jobId, table.resumeId, table.policyVersion),
    // perf/scan-overhead: sumCostUsdSince (jobScores.ts) full-scans this
    // table by createdAt on every worker kick when CALIBER_DAILY_LLM_USD is set.
    index("job_scores_created_at_idx").on(table.createdAt),
  ],
);

export const applicationAnswers = sqliteTable("application_answers", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id),
  jobId: text("job_id").notNull().references(() => jobs.id),
  resumeId: text("resume_id").notNull().references(() => resumes.id), // reconciliation 4
  formSource: text("form_source", { enum: ["ats-api", "fetched", "pasted"] }).notNull(),
  answers: text("answers", { mode: "json" }).$type<ApplicationAnswerEntry[]>().notNull(), // reconciliation 4 shape
  model: text("model").notNull(),
  costUsd: real("cost_usd").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const tailoredResumes = sqliteTable("tailored_resumes", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id),
  jobId: text("job_id").notNull().references(() => jobs.id),
  baseResumeId: text("base_resume_id").notNull().references(() => resumes.id),
  reportId: text("report_id").references(() => correlationReports.id),
  structured: text("structured", { mode: "json" }).$type<ResumeStore>(), // null until completed (mirrors src/types TailoredResume.resume)
  diff: text("diff", { mode: "json" }).$type<TailoredResumeDiffEntry[]>().notNull(), // reconciliation 3 shape
  html: text("html"),
  pdfPath: text("pdf_path"),
  status: text("status", { enum: ["queued", "running", "completed", "failed"] }).notNull(), // reconciliation 2
  finalizedAt: integer("finalized_at", { mode: "timestamp_ms" }), // reconciliation 2 (new column, gates GET .../pdf)
  // task-B8 review fix (Finding 2): the accepted index set from the LAST
  // POST .../finalize call. `structured` above is immutable once completed —
  // it never gets overwritten with the accepted-only merge — so re-finalize
  // just updates this column + finalizedAt, and the merged view is
  // recomputed fresh from (base résumé + structured + acceptedIndices) on
  // every read (server/tailor/assemble.ts, renderTailorPdf). Null until the
  // first finalize; DB-internal, never on the wire (`TailoredResume` shape
  // unchanged).
  acceptedIndices: text("accepted_indices", { mode: "json" }).$type<number[]>(),
  atsDelta: text("ats_delta", { mode: "json" }).$type<{ before: number; after: number; total: number }>(),
  // B8: frozen `TailoredResume.model` (src/types) is a required string, even on
  // the queued/202 draft — populated from config/models.yml's static "tailor"
  // task routing at insert time, then overwritten with the LLM call's actual
  // `result.model` on completion (matches config in real OpenRouter use;
  // mock-LLM tests deliberately diverge to prove the overwrite happens).
  model: text("model").notNull(),
  costUsd: real("cost_usd"), // null until the run completes
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }), // B8: frozen `TailoredResume.completedAt` — set when analyze/rewrite/render finishes, distinct from `finalizedAt` (the later accept-subset action)
});

export const correlationReports = sqliteTable("correlation_reports", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id),
  jobId: text("job_id").notNull().references(() => jobs.id),
  resumeId: text("resume_id").notNull().references(() => resumes.id),
  rows: text("rows", { mode: "json" }).$type<CorrelationReportRowJson[]>().notNull(),
  semantic: text("semantic", { mode: "json" }).$type<{ met: number; buried: number; gap: number; total: number }>(),
  ats: text("ats", { mode: "json" }).$type<{ present: number; total: number; missing: string[] }>(),
  status: text("status", { enum: ["queued", "running", "completed", "failed"] }).notNull(),
  model: text("model").notNull(),
  costUsd: real("cost_usd"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
});

// Spec 2026-07-12-pasted-job-ingestion-design.md §10: async paste-a-URL
// pipeline state. `dedupeKey` mirrors jobs.dedupeKey's normalization for
// run.ts's admission short-circuit (best-effort, not a DB unique
// constraint — §10 "concurrent duplicate pastes" accepts double-spend).
// job_id nulls on delete: url_checks is a log of an action, not a foreign
// owner of the job — deleting a pasted job must not cascade into its own
// audit trail.
export const urlChecks = sqliteTable(
  "url_checks",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull().references(() => users.id),
    url: text("url").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    status: text("status", { enum: ["queued", "running", "completed", "failed"] }).notNull(),
    stage: text("stage"),
    jobId: text("job_id").references(() => jobs.id, { onDelete: "set null" }),
    alreadyKnown: integer("already_known", { mode: "boolean" }).notNull(),
    needsText: integer("needs_text", { mode: "boolean" }).notNull(),
    error: text("error", { mode: "json" }).$type<{ code: string; message: string }>(),
    costUsd: real("cost_usd").notNull(),
    raw: text("raw", { mode: "json" }).$type<unknown>().notNull(),
    // Governs orphan recovery only (max 2 attempts) — never in-run retries.
    attempts: integer("attempts").notNull().default(0),
    // Set at claim to now()+8min; the server lease owns row liveness (spec §4.7).
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("url_checks_queued_idx").on(t.status, t.createdAt).where(sql`${t.status} = 'queued'`),
    // perf/scan-overhead: sweepExpiredLeases/requeueOrphanedRunning scan
    // status='running' rows — mirrors the queued partial index above.
    index("url_checks_running_idx").on(t.status, t.leaseExpiresAt).where(sql`${t.status} = 'running'`),
  ],
);

export const applications = sqliteTable("applications", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id),
  jobId: text("job_id").notNull().references(() => jobs.id).unique(),
  resumeId: text("resume_id").notNull().references(() => resumes.id),
  tailoredResumeId: text("tailored_resume_id").references(() => tailoredResumes.id),
  answersId: text("answers_id").references(() => applicationAnswers.id),
  stage: integer("stage").notNull(), // 0..3, validated at the API boundary
  statusLabel: text("status_label").notNull(),
  statusTone: text("status_tone", { enum: ["good", "verified", "neutral"] }).notNull(),
  note: text("note").notNull(),
  appliedAt: integer("applied_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

// Multi-tenant identity (spec: 2026-07-14 auth core). Passwords argon2id;
// sessions store only the SHA-256 hash of an opaque token. role gates the
// admin surface — no separate admins table (additive capability only).
export const users = sqliteTable("users", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  email: text("email").notNull().unique(), // normalized lowercase at the repo boundary
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["user", "admin"] }).notNull(), // written explicitly at insert — no column default (no-fallback)
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(), // SHA-256 of the opaque cookie token
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});
