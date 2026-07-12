// Drizzle pg-core schema — the 8 tables per docs/architecture/system-architecture.md §1,
// with the 4 src/types-wins reconciliations from .superpowers/sdd/task-B1-brief.md applied
// (search_runs.status / tailored_resumes.status+finalizedAt / tailored_resumes.diff /
// application_answers shape+resumeId). Postgres everywhere — see db.ts / test-db.ts.
import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { ResumeStore } from "../resume/resume-store";

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
};

// ---- tables ----

export const sources = pgTable("sources", {
  id: text("id").primaryKey(), // natural key: 'greenhouse' | 'lever' | 'ashby' | 'jobstreet' | ...
  name: text("name").notNull(), // display label for Job.source.name (SourceRef) — B6 addition, no prior home
  kind: text("kind", { enum: ["ats", "board", "manual"] }).notNull(),
  persona: text("persona", { enum: ["remote", "local", "both"] }).notNull(),
  enabled: boolean("enabled").notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Operator profile — singleton row, id is the constant "default". Seeded by
// seed.ts (the seed is the install step); repos/profile.ts throws
// ProfileMissingError when absent — no runtime default.
export const profile = pgTable("profile", {
  id: text("id").primaryKey(),
  baseCountry: text("base_country").notNull(),
  relocation: text("relocation", { enum: ["stay", "open"] }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const resumes = pgTable("resumes", {
  id: uuid("id").primaryKey().defaultRandom(),
  rawText: text("raw_text").notNull(),
  structured: jsonb("structured").$type<ResumeStore>().notNull(),
  originalPath: text("original_path"),
  sourceKind: text("source_kind", { enum: ["pdf", "docx", "paste"] }).notNull(),
  atsScore: numeric("ats_score", { mode: "number" }),
  isActive: boolean("is_active").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const searchRuns = pgTable("search_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  resumeId: uuid("resume_id").notNull().references(() => resumes.id),
  personas: jsonb("personas").$type<("remote" | "local")[]>().notNull(),
  status: text("status", { enum: ["queued", "running", "completed", "failed"] }).notNull(), // reconciliation 1
  stats: jsonb("stats").$type<SearchRunStats>().notNull(),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  finishedAt: timestamp("finished_at"),
  error: text("error"),
});

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  dedupeKey: text("dedupe_key").notNull().unique(),
  url: text("url").notNull(),
  applyUrl: text("apply_url"),
  sourceId: text("source_id").notNull().references(() => sources.id),
  externalId: text("external_id"),
  title: text("title").notNull(),
  company: text("company").notNull(),
  location: text("location").notNull(),
  salaryRaw: text("salary_raw"),
  description: text("description"),
  postedAt: timestamp("posted_at"),
  firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  persona: text("persona", { enum: ["remote", "local", "pasted"] }).notNull(),
  // Spec 2026-07-12 §4: eligibility tier relative to the profile, stamped at
  // ingest (Layers A+B), refreshed by the scoring path (Layer C). Facts stay
  // in `raw` + job_scores.jd_facts — the tier is recomputable, pure, no LLM.
  eligibility: text("eligibility", { enum: ["anywhere", "eligible", "local", "abroad", "unknown"] }).notNull(),
  eligibilityEvidence: text("eligibility_evidence").notNull(),
  aliases: jsonb("aliases").$type<JobAlias[]>().notNull(),
  raw: jsonb("raw").$type<unknown>().notNull(),
});

export const jobScores = pgTable(
  "job_scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id").notNull().references(() => jobs.id),
    resumeId: uuid("resume_id").notNull().references(() => resumes.id),
    score: numeric("score", { precision: 3, scale: 1, mode: "number" }).notNull(),
    verdict: text("verdict", { enum: ["Apply", "Consider", "Research first", "Skip"] }).notNull(),
    why: text("why").notNull(), // frozen Job.why — one-line rationale, part of EvalScores model output (B6 addition)
    legitimacy: jsonb("legitimacy").$type<LegitimacyShape>().notNull(),
    liveness: text("liveness", { enum: ["active", "expired", "uncertain"] }).notNull(),
    breakdown: jsonb("breakdown").$type<BreakdownEntry[]>().notNull(),
    reasons: jsonb("reasons").$type<ReasonsShape>().notNull(),
    fit: jsonb("fit").$type<FitEntry[]>().notNull(),
    gaps: jsonb("gaps").$type<GapEntry[]>().notNull(),
    jdFacts: jsonb("jd_facts").$type<unknown>().notNull(),
    model: text("model").notNull(),
    escalated: boolean("escalated").notNull(),
    costUsd: numeric("cost_usd", { precision: 8, scale: 4, mode: "number" }).notNull(),
    policyVersion: text("policy_version").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [unique("job_scores_job_resume_policy_unique").on(table.jobId, table.resumeId, table.policyVersion)],
);

export const applicationAnswers = pgTable("application_answers", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobs.id),
  resumeId: uuid("resume_id").notNull().references(() => resumes.id), // reconciliation 4
  formSource: text("form_source", { enum: ["ats-api", "fetched", "pasted"] }).notNull(),
  answers: jsonb("answers").$type<ApplicationAnswerEntry[]>().notNull(), // reconciliation 4 shape
  model: text("model").notNull(),
  costUsd: numeric("cost_usd", { precision: 8, scale: 4, mode: "number" }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const tailoredResumes = pgTable("tailored_resumes", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobs.id),
  baseResumeId: uuid("base_resume_id").notNull().references(() => resumes.id),
  structured: jsonb("structured").$type<ResumeStore>(), // null until completed (mirrors src/types TailoredResume.resume)
  diff: jsonb("diff").$type<TailoredResumeDiffEntry[]>().notNull(), // reconciliation 3 shape
  html: text("html"),
  pdfPath: text("pdf_path"),
  status: text("status", { enum: ["queued", "running", "completed", "failed"] }).notNull(), // reconciliation 2
  finalizedAt: timestamp("finalized_at"), // reconciliation 2 (new column, gates GET .../pdf)
  // task-B8 review fix (Finding 2): the accepted index set from the LAST
  // POST .../finalize call. `structured` above is immutable once completed —
  // it never gets overwritten with the accepted-only merge — so re-finalize
  // just updates this column + finalizedAt, and the merged view is
  // recomputed fresh from (base résumé + structured + acceptedIndices) on
  // every read (server/tailor/assemble.ts, renderTailorPdf). Null until the
  // first finalize; DB-internal, never on the wire (`TailoredResume` shape
  // unchanged).
  acceptedIndices: jsonb("accepted_indices").$type<number[]>(),
  // B8: frozen `TailoredResume.model` (src/types) is a required string, even on
  // the queued/202 draft — populated from config/models.yml's static "tailor"
  // task routing at insert time, then overwritten with the LLM call's actual
  // `result.model` on completion (matches config in real OpenRouter use;
  // mock-LLM tests deliberately diverge to prove the overwrite happens).
  model: text("model").notNull(),
  costUsd: numeric("cost_usd", { precision: 8, scale: 4, mode: "number" }), // null until the run completes
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"), // B8: frozen `TailoredResume.completedAt` — set when analyze/rewrite/render finishes, distinct from `finalizedAt` (the later accept-subset action)
});

// Spec 2026-07-12-pasted-job-ingestion-design.md §10: async paste-a-URL
// pipeline state. `dedupeKey` mirrors jobs.dedupeKey's normalization for
// run.ts's admission short-circuit (best-effort, not a DB unique
// constraint — §10 "concurrent duplicate pastes" accepts double-spend).
// job_id nulls on delete: url_checks is a log of an action, not a foreign
// owner of the job — deleting a pasted job must not cascade into its own
// audit trail.
export const urlChecks = pgTable("url_checks", {
  id: uuid("id").primaryKey().defaultRandom(),
  url: text("url").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  status: text("status", { enum: ["queued", "running", "completed", "failed"] }).notNull(),
  stage: text("stage"),
  jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
  alreadyKnown: boolean("already_known").notNull(),
  needsText: boolean("needs_text").notNull(),
  error: jsonb("error").$type<{ code: string; message: string }>(),
  costUsd: numeric("cost_usd", { precision: 8, scale: 4, mode: "number" }).notNull(),
  raw: jsonb("raw").$type<unknown>().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  finishedAt: timestamp("finished_at"),
});

export const applications = pgTable("applications", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobs.id).unique(),
  resumeId: uuid("resume_id").notNull().references(() => resumes.id),
  tailoredResumeId: uuid("tailored_resume_id").references(() => tailoredResumes.id),
  answersId: uuid("answers_id").references(() => applicationAnswers.id),
  stage: integer("stage").notNull(), // 0..3, validated at the API boundary
  statusLabel: text("status_label").notNull(),
  statusTone: text("status_tone", { enum: ["good", "verified", "neutral"] }).notNull(),
  note: text("note").notNull(),
  appliedAt: timestamp("applied_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
