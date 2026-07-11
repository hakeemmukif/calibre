import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { applications, jobs, jobScores } from "../schema";
import type { Db } from "./db";

export type NewApplication = typeof applications.$inferInsert;
export type AppRow = typeof applications.$inferSelect;

// Typed conflict for the `applications.jobId` UNIQUE constraint (api-contract
// §3 POST /api/applications: duplicate jobId → 409 CONFLICT, details:{existingId}).
export class ApplicationConflictError extends Error {
  constructor(public readonly existingId: string) {
    super(`application already exists for this jobId (id=${existingId})`);
    this.name = "ApplicationConflictError";
  }
}

// Flattened join — applications ⋈ jobs ⋈ job_scores — supplying the
// role/company/meta/score the wire `Application` needs directly (phase-b-
// backend.md B9: no separate assemble step for the tracker, unlike Jobs).
// `meta` mirrors the Feed row's "company/location/comp" sub-line
// (component-inventory.md JobRow) built from the job's location + salary.
export type AppJoinJobScore = AppRow & {
  role: string;
  company: string;
  meta: string;
  score: number;
};

export type AppQuery = {
  stage?: 0 | 1 | 2 | 3;
  statusTone?: "good" | "verified" | "neutral";
  cursor?: string;
  limit?: number;
};

export type AppPatch = Pick<
  AppRow,
  "stage" | "statusLabel" | "statusTone" | "note" | "tailoredResumeId" | "answersId"
>;

const DEFAULT_LIMIT = 25;

// id-correlated keyset: the comparison tuple is fetched fresh from the DB
// (full microsecond precision) rather than round-tripped through a JS Date,
// which only carries millisecond precision and would silently drop rows
// sharing a millisecond with the cursor row.
type Cursor = { id: string };

function encodeCursor(row: AppRow): string {
  const c: Cursor = { id: row.id };
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

function decodeCursor(cursor: string): Cursor {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
}

// A job may carry multiple job_scores rows (résumé replacement / policy bump
// — unique key is (jobId, resumeId, policyVersion)). Joins must pick exactly
// one — the latest by created_at — so an application never fans out into
// duplicate rows and getJoined never returns an arbitrary score.
function latestJobScores(db: Db) {
  return db
    .selectDistinctOn([jobScores.jobId], { id: jobScores.id })
    .from(jobScores)
    .orderBy(jobScores.jobId, desc(jobScores.createdAt), desc(jobScores.id))
    .as("latest_job_scores");
}

function metaOf(location: string, salaryRaw: string | null): string {
  return [location, salaryRaw].filter((v): v is string => Boolean(v)).join(" · ");
}

export function createApplicationsRepo(db: Db) {
  return {
    async insertUniqueByJob(row: NewApplication): Promise<AppRow> {
      try {
        const [inserted] = await db.insert(applications).values(row).returning();
        return inserted;
      } catch (err: unknown) {
        // drizzle wraps driver errors in a "Failed query" error; the pg
        // unique_violation code is on the original error at `.cause`.
        const code = (err as { code?: string; cause?: { code?: string } })?.cause?.code;
        if (code === "23505") {
          const [existing] = await db
            .select()
            .from(applications)
            .where(eq(applications.jobId, row.jobId))
            .limit(1);
          if (existing) throw new ApplicationConflictError(existing.id);
        }
        throw err;
      }
    },

    async listJoined(q: AppQuery): Promise<{ items: AppJoinJobScore[]; nextCursor: string | null }> {
      const limit = q.limit ?? DEFAULT_LIMIT;
      const conditions = [];
      if (q.stage !== undefined) conditions.push(eq(applications.stage, q.stage));
      if (q.statusTone) conditions.push(eq(applications.statusTone, q.statusTone));
      if (q.cursor) {
        const c = decodeCursor(q.cursor);
        conditions.push(
          sql`(${applications.appliedAt}, ${applications.id}) < (SELECT ${applications.appliedAt}, ${applications.id} FROM ${applications} WHERE ${applications.id} = ${c.id})`,
        );
      }

      const latest = latestJobScores(db);

      const rows = await db
        .select({
          application: applications,
          role: jobs.title,
          company: jobs.company,
          location: jobs.location,
          salaryRaw: jobs.salaryRaw,
          score: jobScores.score,
        })
        .from(applications)
        .innerJoin(jobs, eq(jobs.id, applications.jobId))
        .innerJoin(jobScores, eq(jobScores.jobId, jobs.id))
        .innerJoin(latest, eq(latest.id, jobScores.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(applications.appliedAt), desc(applications.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const items: AppJoinJobScore[] = page.map((r) => ({
        ...r.application,
        role: r.role,
        company: r.company,
        meta: metaOf(r.location, r.salaryRaw),
        score: r.score,
      }));
      const nextCursor = hasMore ? encodeCursor(page[page.length - 1].application) : null;
      return { items, nextCursor };
    },

    async getJoined(id: string): Promise<AppJoinJobScore | null> {
      const latest = latestJobScores(db);
      const [row] = await db
        .select({
          application: applications,
          role: jobs.title,
          company: jobs.company,
          location: jobs.location,
          salaryRaw: jobs.salaryRaw,
          score: jobScores.score,
        })
        .from(applications)
        .innerJoin(jobs, eq(jobs.id, applications.jobId))
        .innerJoin(jobScores, eq(jobScores.jobId, jobs.id))
        .innerJoin(latest, eq(latest.id, jobScores.id))
        .where(eq(applications.id, id))
        .limit(1);
      if (!row) return null;
      return {
        ...row.application,
        role: row.role,
        company: row.company,
        meta: metaOf(row.location, row.salaryRaw),
        score: row.score,
      };
    },

    async patch(id: string, p: Partial<AppPatch>): Promise<AppRow | null> {
      const [updated] = await db
        .update(applications)
        .set({ ...p, updatedAt: sql`now()` })
        .where(eq(applications.id, id))
        .returning();
      return updated ?? null;
    },
  };
}

export const applicationsRepo: ReturnType<typeof createApplicationsRepo> = {
  insertUniqueByJob: (row) => createApplicationsRepo(getDb()).insertUniqueByJob(row),
  listJoined: (q) => createApplicationsRepo(getDb()).listJoined(q),
  getJoined: (id) => createApplicationsRepo(getDb()).getJoined(id),
  patch: (id, p) => createApplicationsRepo(getDb()).patch(id, p),
};
