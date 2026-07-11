import { desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../db";
import { jobScores } from "../schema";
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
    async getById(id: string): Promise<JobScoreRow | null> {
      const [row] = await db.select().from(jobScores).where(eq(jobScores.id, id)).limit(1);
      return row ?? null;
    },
    // B7 apply-assistant: draftAnswers grounds better when a job has already
    // been scored (JdFacts). A job can carry multiple job_scores rows (résumé
    // replacement / policy bump) — this picks the most recent one by
    // created_at, regardless of resumeId (v1 holds exactly one active résumé).
    async getLatestByJobId(jobId: string): Promise<JobScoreRow | null> {
      const [row] = await db
        .select()
        .from(jobScores)
        .where(eq(jobScores.jobId, jobId))
        .orderBy(desc(jobScores.createdAt))
        .limit(1);
      return row ?? null;
    },
    // system-architecture.md §6 decision 8 "daily cap env var" — server/search/run.ts
    // sums today's spend across ALL runs before scoring another job this run.
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
  getById: (id) => createJobScoresRepo(getDb()).getById(id),
  sumCostUsdSince: (cutoff) => createJobScoresRepo(getDb()).sumCostUsdSince(cutoff),
  getLatestByJobId: (jobId) => createJobScoresRepo(getDb()).getLatestByJobId(jobId),
};
