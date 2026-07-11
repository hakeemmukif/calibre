import { eq } from "drizzle-orm";
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
  };
}

export const jobScoresRepo: ReturnType<typeof createJobScoresRepo> = {
  upsertByJobResumePolicy: (row) => createJobScoresRepo(getDb()).upsertByJobResumePolicy(row),
  getById: (id) => createJobScoresRepo(getDb()).getById(id),
};
