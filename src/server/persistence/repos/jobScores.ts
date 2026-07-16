import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../db";
import { jobs, jobScores } from "../schema";
import type { Db } from "./db";

export type NewJobScore = typeof jobScores.$inferInsert;
export type JobScoreRow = typeof jobScores.$inferSelect;

export function createJobScoresRepo(db: Db) {
  return {
    // UNIQUE (jobId, resumeId, policyVersion) is the verdict cache
    // (system-architecture.md §1) — `server/score` re-scores on every run,
    // so this is upsert-returning rather than insert-or-throw.
    async upsertByJobResumePolicy(row: NewJobScore): Promise<JobScoreRow> {
      const [upserted] = await db
        .insert(jobScores)
        .values(row)
        .onConflictDoUpdate({
          target: [jobScores.jobId, jobScores.resumeId, jobScores.policyVersion],
          set: {
            score: row.score,
            verdict: row.verdict,
            why: row.why,
            legitimacy: row.legitimacy,
            liveness: row.liveness,
            breakdown: row.breakdown,
            reasons: row.reasons,
            fit: row.fit,
            gaps: row.gaps,
            jdFacts: row.jdFacts,
            model: row.model,
            escalated: row.escalated,
            costUsd: row.costUsd,
          },
        })
        .returning();
      return upserted;
    },
    // Rescan skip gate (perf/scan-overhead): server/search/run.ts checks this
    // before spending an LLM call on a top candidate — a job already scored
    // for the exact (job, résumé, policy version) tuple is served from the
    // cache untouched. Scoped via a join back to `jobs` (mirrors
    // jobsRepo.hasAnyScore), so a foreign jobId can never answer true.
    async existsByJobResumePolicy(
      jobId: string,
      resumeId: string,
      policyVersion: string,
      userId: string,
    ): Promise<boolean> {
      const [row] = await db
        .select({ id: jobScores.id })
        .from(jobScores)
        .innerJoin(jobs, eq(jobs.id, jobScores.jobId))
        .where(
          and(
            eq(jobScores.jobId, jobId),
            eq(jobScores.resumeId, resumeId),
            eq(jobScores.policyVersion, policyVersion),
            eq(jobs.userId, userId),
          ),
        )
        .limit(1);
      return row !== undefined;
    },
    // GLOBAL-BY-DECISION: no production call site (test-only round-trip
    // accessor) — nothing routes untrusted input into this lookup today, so
    // there is no cross-tenant read path to scope. Thread userId first if a
    // real caller ever appears.
    async getById(id: string): Promise<JobScoreRow | null> {
      const [row] = await db.select().from(jobScores).where(eq(jobScores.id, id)).limit(1);
      return row ?? null;
    },
    // B7 apply-assistant: draftAnswers grounds better when a job has already
    // been scored (JdFacts). A job can carry multiple job_scores rows (résumé
    // replacement / policy bump) — this picks the most recent one by
    // created_at, regardless of resumeId (v1 holds exactly one active résumé).
    // GLOBAL-BY-DECISION: no user_id filter here (step 3 plan, Task 3) —
    // caller verifies job ownership first (draftAnswers gates on
    // jobsRepo.existsById before this is ever called).
    async getLatestByJobId(jobId: string): Promise<JobScoreRow | null> {
      const [row] = await db
        .select()
        .from(jobScores)
        .where(eq(jobScores.jobId, jobId))
        // desc(id) tie-breaks a created_at tie deterministically (id is uuid,
        // so "highest" is arbitrary but stable, not Postgres's undefined pick).
        .orderBy(desc(jobScores.createdAt), desc(jobScores.id))
        .limit(1);
      return row ?? null;
    },
    // GLOBAL-BY-DECISION: system-architecture.md §6 decision 8 "daily cap env
    // var" — server/search/run.ts sums today's spend across ALL runs, across
    // every tenant, before scoring another job this run. Deliberately global.
    async sumCostUsdSince(cutoff: Date): Promise<number> {
      const [row] = await db
        .select({ total: sql<string | null>`sum(${jobScores.costUsd})` })
        .from(jobScores)
        .where(gte(jobScores.createdAt, cutoff));
      return row?.total ? Number(row.total) : 0;
    },
  };
}

export const jobScoresRepo: ReturnType<typeof createJobScoresRepo> = {
  upsertByJobResumePolicy: (row) => createJobScoresRepo(getDb()).upsertByJobResumePolicy(row),
  existsByJobResumePolicy: (jobId, resumeId, policyVersion, userId) =>
    createJobScoresRepo(getDb()).existsByJobResumePolicy(jobId, resumeId, policyVersion, userId),
  getById: (id) => createJobScoresRepo(getDb()).getById(id),
  sumCostUsdSince: (cutoff) => createJobScoresRepo(getDb()).sumCostUsdSince(cutoff),
  getLatestByJobId: (jobId) => createJobScoresRepo(getDb()).getLatestByJobId(jobId),
};
