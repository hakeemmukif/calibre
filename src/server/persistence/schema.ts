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
type SearchRunStats = { scanned: number; matched: number; scored: number; ghosts: number; perSource: PerSourceStat[] };

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
  kind: text("kind", { enum: ["ats", "board"] }).notNull(),
  persona: text("persona", { enum: ["remote", "local", "both"] }).notNull(),
  enabled: boolean("enabled").notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
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
  persona: text("persona", { enum: ["remote", "local"] }).notNull(),
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
  model: text("model"), // null until the run completes (see report: extension of reconciliation 2)
  costUsd: numeric("cost_usd", { precision: 8, scale: 4, mode: "number" }), // null until the run completes
  createdAt: timestamp("created_at").notNull().defaultNow(),
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
