// Task 14 (spec §10 "DELETE /api/jobs/:id"): pasted-job deletion. Guard
// order is load-bearing — 404 unknown, then 409 not-pasted, then 409
// application-exists — the lifelong-tracker promise wins over deletion, so
// the application check must run BEFORE any row is touched. Every FK onto
// `jobs` from application_answers/tailored_resumes/correlation_reports/
// job_scores/applications is the drizzle default (NO ACTION == RESTRICT in
// Postgres — schema.ts sets no `onDelete` on any of them), so those
// dependents must be removed, in that order, before the `jobs` row itself.
// `correlation_reports` must be deleted AFTER `tailored_resumes` —
// `tailored_resumes.report_id` FKs `correlation_reports.id`, so a report row
// still referenced by a not-yet-deleted tailored_resumes row would itself
// hit the same RESTRICT. `url_checks.job_id` is the one exception (`ON
// DELETE SET NULL`) — it needs no explicit cleanup here.
import { eq } from "drizzle-orm";
import { getDb } from "@/server/persistence/db";
import { jobsRepo } from "@/server/persistence/repos/jobs";
import {
  applicationAnswers,
  applications,
  correlationReports,
  jobScores,
  jobs,
  tailoredResumes,
} from "@/server/persistence/schema";

export class UnknownJobError extends Error {
  constructor(jobId: string) {
    super(`No job with id "${jobId}".`);
    this.name = "UnknownJobError";
  }
}

export class NotDeletableError extends Error {
  constructor(jobId: string) {
    super(`Job "${jobId}" is not a pasted job — deletion is limited to persona 'pasted'.`);
    this.name = "NotDeletableError";
  }
}

export class ApplicationExistsError extends Error {
  constructor(jobId: string) {
    super(`Job "${jobId}" has a tracked application — deletion blocked.`);
    this.name = "ApplicationExistsError";
  }
}

export async function deletePastedJob(jobId: string, userId: string): Promise<void> {
  const row = await jobsRepo.getRowWithSourceById(jobId, userId);
  if (!row) throw new UnknownJobError(jobId);
  if (row.job.persona !== "pasted") throw new NotDeletableError(jobId);

  const db = getDb();
  const [existingApp] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(eq(applications.jobId, jobId))
    .limit(1);
  if (existingApp) throw new ApplicationExistsError(jobId);

  // Ordered single deletes, NOT db.transaction() (global constraint — the
  // libsql file: driver corrupts under concurrent interactive transactions).
  // Every statement is idempotent and the `jobs` row goes last, so a crash
  // mid-sequence re-runs cleanly: the guards above still resolve the job and
  // the earlier deletes are no-ops the second time. Order is FK-driven (see
  // the module doc-comment): dependents before `jobs`, tailored_resumes
  // before correlation_reports.
  await db.delete(applicationAnswers).where(eq(applicationAnswers.jobId, jobId));
  await db.delete(tailoredResumes).where(eq(tailoredResumes.jobId, jobId));
  await db.delete(correlationReports).where(eq(correlationReports.jobId, jobId));
  await db.delete(jobScores).where(eq(jobScores.jobId, jobId));
  await db.delete(jobs).where(eq(jobs.id, jobId));
}
