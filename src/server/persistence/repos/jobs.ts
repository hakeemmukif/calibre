import { and, desc, eq, gte, ilike, inArray, or, sql } from "drizzle-orm";
import { getDb } from "../db";
import { jobs, jobScores } from "../schema";
import type { Db } from "./db";

export type NewJob = typeof jobs.$inferInsert;
export type JobRow = typeof jobs.$inferSelect;
export type JobScoreRow = typeof jobScores.$inferSelect;

// Raw jobs⋈job_scores pair — deliberately unflattened. Turning this into the
// frozen `Job` wire shape (applyUrl fallback, `source`, `isNew`, tags/etc.) is
// `features/feed/assemble.ts`'s job (see phase-b-backend.md B6), not the
// repo's — B1 only supplies the joined rows a later slice assembles.
export type JobJoinScore = { job: JobRow; score: JobScoreRow };

export type JobsQuery = {
  persona?: "remote" | "local";
  tier?: string[]; // job_scores.legitimacy.tier, repeatable (api-contract §3 `tier?`)
  minScore?: number;
  // Cutoff timestamp, not the wire boolean: "isNew"/"since last visit" is
  // computed from search_runs (previous completed run's finishedAt per
  // phase-b-backend.md B6's `sinceLast` definition) — a cross-table concern
  // that belongs to the caller (features/feed), not this single-table repo.
  // The caller resolves the wire `isNew?: boolean` into this cutoff.
  isNew?: Date;
  remote?: boolean; // "Remote" filter chip (design spec §11.8) → persona = 'remote'
  q?: string; // ILIKE over title/company
  cursor?: string;
  limit?: number;
};

const DEFAULT_LIMIT = 25;

type Cursor = { firstSeenAt: string; id: string };

function encodeCursor(row: JobRow): string {
  const c: Cursor = { firstSeenAt: row.firstSeenAt.toISOString(), id: row.id };
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

function decodeCursor(cursor: string): Cursor {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
}

export function createJobsRepo(db: Db) {
  return {
    // ON CONFLICT (dedupeKey): refresh lastSeenAt/aliases, keep firstSeenAt
    // (untouched — Postgres retains the existing value for any column absent
    // from the update `set`).
    async upsertByDedupeKey(row: NewJob): Promise<JobRow> {
      const [upserted] = await db
        .insert(jobs)
        .values(row)
        .onConflictDoUpdate({
          target: jobs.dedupeKey,
          set: { lastSeenAt: sql`now()`, aliases: row.aliases },
        })
        .returning();
      return upserted;
    },

    async listScored(q: JobsQuery): Promise<{ items: JobJoinScore[]; nextCursor: string | null }> {
      const limit = q.limit ?? DEFAULT_LIMIT;
      const conditions = [];

      if (q.persona) conditions.push(eq(jobs.persona, q.persona));
      if (q.remote) conditions.push(eq(jobs.persona, "remote"));
      if (q.tier && q.tier.length > 0) {
        conditions.push(inArray(sql`(${jobScores.legitimacy}->>'tier')`, q.tier));
      }
      if (q.minScore !== undefined) conditions.push(gte(jobScores.score, q.minScore));
      if (q.isNew) conditions.push(gte(jobs.firstSeenAt, q.isNew));
      if (q.q) {
        const like = `%${q.q}%`;
        conditions.push(or(ilike(jobs.title, like), ilike(jobs.company, like)));
      }
      if (q.cursor) {
        const c = decodeCursor(q.cursor);
        conditions.push(sql`(${jobs.firstSeenAt}, ${jobs.id}) < (${new Date(c.firstSeenAt)}, ${c.id})`);
      }

      const rows = await db
        .select({ job: jobs, score: jobScores })
        .from(jobs)
        .innerJoin(jobScores, eq(jobScores.jobId, jobs.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(jobs.firstSeenAt), desc(jobs.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? encodeCursor(items[items.length - 1].job) : null;
      return { items, nextCursor };
    },

    async getById(id: string): Promise<JobJoinScore | null> {
      const [row] = await db
        .select({ job: jobs, score: jobScores })
        .from(jobs)
        .innerJoin(jobScores, eq(jobScores.jobId, jobs.id))
        .where(eq(jobs.id, id))
        .limit(1);
      return row ?? null;
    },
  };
}

export const jobsRepo: ReturnType<typeof createJobsRepo> = {
  upsertByDedupeKey: (row) => createJobsRepo(getDb()).upsertByDedupeKey(row),
  listScored: (q) => createJobsRepo(getDb()).listScored(q),
  getById: (id) => createJobsRepo(getDb()).getById(id),
};
