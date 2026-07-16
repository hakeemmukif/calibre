import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { applications, jobs, jobScores } from "../schema";
import { decodeCursorId, encodeCursorId } from "./cursor";
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
  userId: string;
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

// A job may carry multiple job_scores rows (résumé replacement / policy bump
// — unique key is (jobId, resumeId, policyVersion)). Joins must pick exactly
// one — the latest by created_at — so an application never fans out into
// duplicate rows and getJoined never returns an arbitrary score.
function latestJobScores(db: Db) {
  const ranked = db
    .select({
      id: jobScores.id,
      jobId: jobScores.jobId,
      rn: sql<number>`row_number() OVER (PARTITION BY ${jobScores.jobId} ORDER BY ${jobScores.createdAt} DESC, ${jobScores.id} DESC)`.as(
        "rn",
      ),
    })
    .from(jobScores)
    .as("ranked_job_scores");
  return db.select({ id: ranked.id }).from(ranked).where(eq(ranked.rn, 1)).as("latest_job_scores");
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
        // drizzle wraps driver errors in a "Failed query" error; the libsql
        // unique-violation extendedCode is on the original error at `.cause`.
        const code = (err as { cause?: { extendedCode?: string } })?.cause?.extendedCode;
        if (code === "SQLITE_CONSTRAINT_UNIQUE") {
          // Scoped by userId (mechanical audit fix, Step 3 Task 6): jobId is
          // already unique per owning user (each user's scanned job is its
          // own row), so this can't currently resolve to a foreign
          // application — scoping it anyway keeps the guarantee
          // constraint-independent rather than relying on that invariant.
          const [existing] = await db
            .select()
            .from(applications)
            .where(and(eq(applications.jobId, row.jobId), eq(applications.userId, row.userId)))
            .limit(1);
          if (existing) throw new ApplicationConflictError(existing.id);
        }
        throw err;
      }
    },

    async listJoined(q: AppQuery): Promise<{ items: AppJoinJobScore[]; nextCursor: string | null }> {
      const limit = q.limit ?? DEFAULT_LIMIT;
      const conditions = [eq(applications.userId, q.userId)];
      if (q.stage !== undefined) conditions.push(eq(applications.stage, q.stage));
      if (q.statusTone) conditions.push(eq(applications.statusTone, q.statusTone));
      if (q.cursor) {
        const c = decodeCursorId(q.cursor);
        // Cursor-oracle fix (Fable design review, same class as jobs.ts's
        // listScored): the subquery must carry the SAME user_id filter as the
        // outer query, or a cursor encoding another user's application id
        // resolves to a real row here while the outer WHERE still hides it —
        // an existence oracle across tenants.
        conditions.push(
          sql`(${applications.appliedAt}, ${applications.id}) < (SELECT ${applications.appliedAt}, ${applications.id} FROM ${applications} WHERE ${applications.id} = ${c.id} AND ${applications.userId} = ${q.userId})`,
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
      const nextCursor = hasMore ? encodeCursorId(page[page.length - 1].application.id) : null;
      return { items, nextCursor };
    },

    async getJoined(id: string, userId: string): Promise<AppJoinJobScore | null> {
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
        .where(and(eq(applications.id, id), eq(applications.userId, userId)))
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

    // By-uuid PATCH leak fix (Fable design review, CRITICAL): scoped by
    // userId so a foreign application id no-ops (returns null -> caller
    // 404s) instead of updating another tenant's row.
    async patch(id: string, userId: string, p: Partial<AppPatch>): Promise<AppRow | null> {
      const [updated] = await db
        .update(applications)
        .set({ ...p, updatedAt: new Date() })
        .where(and(eq(applications.id, id), eq(applications.userId, userId)))
        .returning();
      return updated ?? null;
    },
  };
}

export const applicationsRepo: ReturnType<typeof createApplicationsRepo> = {
  insertUniqueByJob: (row) => createApplicationsRepo(getDb()).insertUniqueByJob(row),
  listJoined: (q) => createApplicationsRepo(getDb()).listJoined(q),
  getJoined: (id, userId) => createApplicationsRepo(getDb()).getJoined(id, userId),
  patch: (id, userId, p) => createApplicationsRepo(getDb()).patch(id, userId, p),
};
