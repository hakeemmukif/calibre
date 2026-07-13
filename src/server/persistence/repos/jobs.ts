import { and, desc, eq, gt, gte, ilike, inArray, or, sql } from "drizzle-orm";
import type { EligibilityTier, Persona } from "@/types";
import { getDb } from "../db";
import { jobs, jobScores, sources, type JobAlias } from "../schema";
import { decodeCursorId, encodeCursorId } from "./cursor";
import type { Db } from "./db";

export type NewJob = typeof jobs.$inferInsert;
export type JobRow = typeof jobs.$inferSelect;
export type JobScoreRow = typeof jobScores.$inferSelect;
export type SourceRow = typeof sources.$inferSelect;

// Raw jobs⋈job_scores⋈sources triple — deliberately unflattened. Turning this
// into the frozen `Job` wire shape (applyUrl fallback, `source` SourceRef,
// `isNew`, tags/etc.) is `features/feed/assemble.ts`'s job (see
// phase-b-backend.md B6), not the repo's. `source` was added by B6 —
// `Job.source: SourceRef` needs the sources row (name/kind/persona), which a
// {job,score} pair alone can't supply.
export type JobJoinScore = { job: JobRow; score: JobScoreRow; source: SourceRow };

export type JobsQuery = {
  persona?: Persona;
  tier?: string[]; // job_scores.legitimacy.tier, repeatable (api-contract §3 `tier?`)
  minScore?: number;
  // Cutoff timestamp, not the wire boolean: "isNew"/"since last visit" is
  // computed from search_runs (previous completed run's finishedAt per
  // phase-b-backend.md B6's `sinceLast` definition) — a cross-table concern
  // that belongs to the caller (features/feed), not this single-table repo.
  // The caller resolves the wire `isNew?: boolean` into this cutoff.
  isNew?: Date;
  // Server-derived from the profile's relocation preference (spec §8), not a
  // wire param: relocation "stay" passes the 4 admitted tiers, "open" omits
  // the condition entirely.
  eligibility?: EligibilityTier[];
  q?: string; // ILIKE over title/company
  cursor?: string;
  limit?: number;
};

const DEFAULT_LIMIT = 25;

// A job may carry multiple job_scores rows (résumé replacement / policy bump
// — unique key is (jobId, resumeId, policyVersion)). Joins must pick exactly
// one — the latest by created_at — so a job never fans out into duplicate
// rows and getById never returns an arbitrary score.
function latestJobScores(db: Db) {
  return db
    .selectDistinctOn([jobScores.jobId], { id: jobScores.id })
    .from(jobScores)
    // desc(id) tie-breaks a created_at tie deterministically (id is uuid,
    // so "highest" is arbitrary but stable, not Postgres's undefined pick).
    .orderBy(jobScores.jobId, desc(jobScores.createdAt), desc(jobScores.id))
    .as("latest_job_scores");
}

// Shared by listScored (paginated page) and statsForQuery (full scoped set,
// task-B6-brief.md "stats computed server-side over the FULL scoped result
// set, not the page") — same filters, no cursor/limit (those are page-only).
function buildFilterConditions(q: Omit<JobsQuery, "cursor" | "limit">) {
  const conditions = [];
  if (q.persona) conditions.push(eq(jobs.persona, q.persona));
  if (q.eligibility && q.eligibility.length > 0) conditions.push(inArray(jobs.eligibility, q.eligibility));
  if (q.tier && q.tier.length > 0) {
    conditions.push(inArray(sql`(${jobScores.legitimacy}->>'tier')`, q.tier));
  }
  if (q.minScore !== undefined) conditions.push(gte(jobScores.score, q.minScore));
  // Strict `>`, not `>=` — matches assembleJob's `firstSeen > cutoff` and
  // sinceLast's `firstSeenAt > cutoff` (task-B6 fix pass finding 4): a job
  // whose firstSeenAt is exactly the cutoff must be consistent across all
  // three, not "new" only in this filter.
  if (q.isNew) conditions.push(gt(jobs.firstSeenAt, q.isNew));
  if (q.q) {
    const like = `%${q.q}%`;
    conditions.push(or(ilike(jobs.title, like), ilike(jobs.company, like)));
  }
  return conditions;
}

// {sourceId,url}-deduped union — a re-sighting from a source already present
// among the aliases refreshes nothing (idempotent); a new source's alias is
// added. Never drops a previously-recorded alias (task-B5-brief.md alias-
// merge note: `upsertByDedupeKey` used to REPLACE aliases wholesale, wiping
// cross-source aliases on re-sighting).
function mergeAliases(existing: JobAlias[], incoming: JobAlias[]): JobAlias[] {
  const merged = new Map<string, JobAlias>();
  for (const alias of [...existing, ...incoming]) merged.set(`${alias.sourceId}::${alias.url}`, alias);
  return [...merged.values()];
}

export function createJobsRepo(db: Db) {
  return {
    // ON CONFLICT (dedupeKey): refresh lastSeenAt/aliases (merged, not
    // replaced), keep firstSeenAt (untouched — Postgres retains the existing
    // value for any column absent from the update `set`).
    async upsertByDedupeKey(row: NewJob): Promise<JobRow> {
      const [existing] = await db
        .select({ aliases: jobs.aliases })
        .from(jobs)
        .where(eq(jobs.dedupeKey, row.dedupeKey))
        .limit(1);
      const aliases = mergeAliases(existing?.aliases ?? [], row.aliases ?? []);

      const [upserted] = await db
        .insert(jobs)
        .values({ ...row, aliases })
        .onConflictDoUpdate({
          target: jobs.dedupeKey,
          set: { lastSeenAt: sql`now()`, aliases },
        })
        .returning();
      return upserted;
    },

    // url-check admission (spec 2026-07-12-pasted-job-ingestion-design.md §6
    // step 4): a pasted URL's normalized dedupe key may already own a job
    // (scanned or previously pasted) — the admission short-circuit needs a
    // direct lookup, not `getById` (needs a `job_scores` join) or
    // `upsertByDedupeKey` (which would spend a write to answer a read).
    async getByDedupeKey(dedupeKey: string): Promise<JobRow | null> {
      const [row] = await db.select().from(jobs).where(eq(jobs.dedupeKey, dedupeKey)).limit(1);
      return row ?? null;
    },

    // url-check admission self-healing (final review fix wave FIX 1a): a
    // dedupe-hit job may be a PERSISTED-BUT-UNSCORED orphan (a prior
    // startUrlCheck's persist-stage upsert succeeded but scoreJob threw) —
    // short-circuiting to alreadyKnown for that job would hide it forever
    // (every feed/detail view inner-joins job_scores). Callers must only
    // treat a dedupe hit as alreadyKnown when it has at least one score row.
    async hasAnyScore(jobId: string): Promise<boolean> {
      const [row] = await db.select({ id: jobScores.id }).from(jobScores).where(eq(jobScores.jobId, jobId)).limit(1);
      return row !== undefined;
    },

    async listScored(q: JobsQuery): Promise<{ items: JobJoinScore[]; nextCursor: string | null }> {
      const limit = q.limit ?? DEFAULT_LIMIT;
      const conditions = buildFilterConditions(q);

      if (q.cursor) {
        const c = decodeCursorId(q.cursor);
        conditions.push(
          sql`(${jobs.firstSeenAt}, ${jobs.id}) < (SELECT ${jobs.firstSeenAt}, ${jobs.id} FROM ${jobs} WHERE ${jobs.id} = ${c.id})`,
        );
      }

      const latest = latestJobScores(db);

      const rows = await db
        .select({ job: jobs, score: jobScores, source: sources })
        .from(jobs)
        .innerJoin(jobScores, eq(jobScores.jobId, jobs.id))
        .innerJoin(latest, eq(latest.id, jobScores.id))
        .innerJoin(sources, eq(sources.id, jobs.sourceId))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(jobs.firstSeenAt), desc(jobs.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? encodeCursorId(items[items.length - 1].job.id) : null;
      return { items, nextCursor };
    },

    async getById(id: string): Promise<JobJoinScore | null> {
      const latest = latestJobScores(db);
      const [row] = await db
        .select({ job: jobs, score: jobScores, source: sources })
        .from(jobs)
        .innerJoin(jobScores, eq(jobScores.jobId, jobs.id))
        .innerJoin(latest, eq(latest.id, jobScores.id))
        .innerJoin(sources, eq(sources.id, jobs.sourceId))
        .where(eq(jobs.id, id))
        .limit(1);
      return row ?? null;
    },

    // Top-N scoring-path backfill (describe.ts's ensureDescription) — a
    // board connector's search API carries no description, so the detail
    // fetch's result is persisted here once, ahead of scoring. Fail loud on
    // an unknown id rather than silently no-op'ing.
    async updateDescription(id: string, description: string): Promise<JobRow> {
      const [updated] = await db.update(jobs).set({ description }).where(eq(jobs.id, id)).returning();
      if (!updated) throw new Error(`jobsRepo.updateDescription: no job ${id}`);
      return updated;
    },

    // Excluded-count support (spec §8): everything the predicate hid for the
    // scope, scored or not. `jobs` alone — no job_scores/sources join — since
    // relocation "stay" gates abroad rows out of the scoring pool entirely
    // (spec §5 scan hardening); a scored-only count undercounts (live run: 14
    // real abroad jobs, count read 0). `tier`/`minScore` are Omit'd at the
    // type level, not just unused: they're job_scores columns and
    // buildFilterConditions would emit conditions against a table this query
    // never joins — an unscored row has no score to filter on.
    async countHiddenByEligibility(
      q: Omit<JobsQuery, "cursor" | "limit" | "tier" | "minScore">,
    ): Promise<number> {
      const conditions = buildFilterConditions(q);
      const rows = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(conditions.length > 0 ? and(...conditions) : undefined);
      return rows.length;
    },

    // Layer-C refresh (spec §5 write points): the scoring path re-resolves
    // with JD facts and overwrites the ingest-time stamp. Unknown id throws —
    // a refresh for a vanished row is a bug, not a no-op.
    async updateEligibility(id: string, tier: JobRow["eligibility"], evidence: string): Promise<void> {
      const [row] = await db
        .update(jobs)
        .set({ eligibility: tier, eligibilityEvidence: evidence })
        .where(eq(jobs.id, id))
        .returning({ id: jobs.id });
      if (!row) throw new Error(`jobsRepo.updateEligibility: no job with id "${id}"`);
    },

    // Layer-C refresh (spec §5 write points): the scoring path re-resolves
    // tz_band from JD-stated facts (else location) and hiring_structure from
    // the stated enum, overwriting the ingest-time stamp. Unknown id throws —
    // a refresh for a vanished row is a bug, not a no-op.
    async updateRemoteFit(id: string, tzBand: JobRow["tzBand"], hiringStructure: JobRow["hiringStructure"]): Promise<void> {
      const [row] = await db
        .update(jobs)
        .set({ tzBand, hiringStructure })
        .where(eq(jobs.id, id))
        .returning({ id: jobs.id });
      if (!row) throw new Error(`jobsRepo.updateRemoteFit: no job with id "${id}"`);
    },

    // Job+source only (no job_scores join) — Task 6's per-job evaluate
    // endpoint needs a job regardless of whether it's been scored before
    // (unlike `getById`, which requires an existing job_scores row).
    async getRowWithSourceById(id: string): Promise<{ job: JobRow; source: SourceRow } | undefined> {
      const [row] = await db
        .select({ job: jobs, source: sources })
        .from(jobs)
        .innerJoin(sources, eq(sources.id, jobs.sourceId))
        .where(eq(jobs.id, id))
        .limit(1);
      return row ?? undefined;
    },

    // Raw existence check, deliberately NOT `getById` — that method inner-
    // joins job_scores, so an existing-but-unscored job would falsely read
    // as "doesn't exist" here (fix pass finding 3: draftAnswers must 404 an
    // unknown jobId, not an unscored one).
    async existsById(id: string): Promise<boolean> {
      const [row] = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, id)).limit(1);
      return row !== undefined;
    },

    // task-B6-brief.md "stats computed server-side over the FULL scoped
    // result set, not the page" — same filters as listScored, no
    // cursor/limit. Aggregated in JS rather than SQL COUNT FILTER: dataset
    // size is single-operator-MVP small, and it keeps the jsonb->>'tier'
    // comparison logic in one place (buildFilterConditions / tier strings)
    // instead of duplicating it as raw SQL CASE expressions.
    async statsForQuery(
      q: Omit<JobsQuery, "cursor" | "limit">,
      sinceLastCutoff?: Date | null,
    ): Promise<{ scanned: number; worth: number; ghosts: number; flagged: number; sinceLast: number }> {
      const conditions = buildFilterConditions(q);
      const latest = latestJobScores(db);

      const rows = await db
        .select({
          verdict: jobScores.verdict,
          tier: sql<string>`(${jobScores.legitimacy}->>'tier')`,
          firstSeenAt: jobs.firstSeenAt,
        })
        .from(jobs)
        .innerJoin(jobScores, eq(jobScores.jobId, jobs.id))
        .innerJoin(latest, eq(latest.id, jobScores.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      const worthVerdicts = new Set(["Apply", "Consider"]);
      const flaggedTiers = new Set(["suspicious", "ghost", "scam"]);

      return {
        scanned: rows.length,
        worth: rows.filter((r) => worthVerdicts.has(r.verdict)).length,
        ghosts: rows.filter((r) => r.tier === "ghost").length,
        flagged: rows.filter((r) => flaggedTiers.has(r.tier)).length,
        sinceLast: sinceLastCutoff ? rows.filter((r) => r.firstSeenAt > sinceLastCutoff).length : 0,
      };
    },
  };
}

export const jobsRepo: ReturnType<typeof createJobsRepo> = {
  upsertByDedupeKey: (row) => createJobsRepo(getDb()).upsertByDedupeKey(row),
  getByDedupeKey: (dedupeKey) => createJobsRepo(getDb()).getByDedupeKey(dedupeKey),
  hasAnyScore: (jobId) => createJobsRepo(getDb()).hasAnyScore(jobId),
  listScored: (q) => createJobsRepo(getDb()).listScored(q),
  getById: (id) => createJobsRepo(getDb()).getById(id),
  getRowWithSourceById: (id) => createJobsRepo(getDb()).getRowWithSourceById(id),
  updateDescription: (id, description) => createJobsRepo(getDb()).updateDescription(id, description),
  updateEligibility: (id, tier, evidence) => createJobsRepo(getDb()).updateEligibility(id, tier, evidence),
  updateRemoteFit: (id, tzBand, hiringStructure) => createJobsRepo(getDb()).updateRemoteFit(id, tzBand, hiringStructure),
  countHiddenByEligibility: (q) => createJobsRepo(getDb()).countHiddenByEligibility(q),
  existsById: (id) => createJobsRepo(getDb()).existsById(id),
  statsForQuery: (q, sinceLastCutoff) => createJobsRepo(getDb()).statsForQuery(q, sinceLastCutoff),
};
