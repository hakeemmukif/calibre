import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "../db";
import { urlChecks } from "../schema";
import type { Db } from "./db";

export type NewUrlCheck = typeof urlChecks.$inferInsert;
export type UrlCheckRow = typeof urlChecks.$inferSelect;

export function createUrlChecksRepo(db: Db) {
  return {
    async insert(row: NewUrlCheck): Promise<UrlCheckRow> {
      const [inserted] = await db.insert(urlChecks).values(row).returning();
      return inserted;
    },
    async getById(id: string): Promise<UrlCheckRow | null> {
      const [row] = await db.select().from(urlChecks).where(eq(urlChecks.id, id)).limit(1);
      return row ?? null;
    },
    // Atomic claim (spec §4.4). One autocommit UPDATE — never wrapped in a
    // transaction (that would hold a connection across the ~30s run and defeat
    // SKIP LOCKED). The subquery is a raw sql fragment (mirrors the
    // sql`...` fragments already used in jobs.ts/applications.ts); .returning()
    // maps back to a typed UrlCheckRow.
    async claimNextQueued(): Promise<UrlCheckRow | null> {
      const [claimed] = await db
        .update(urlChecks)
        .set({
          status: "running",
          attempts: sql`${urlChecks.attempts} + 1`,
          leaseExpiresAt: sql`now() + interval '8 minutes'`,
        })
        .where(
          sql`${urlChecks.id} = (
            SELECT id FROM url_checks
            WHERE status = 'queued'
            ORDER BY created_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )`,
        )
        .returning();
      return claimed ?? null;
    },
    // Boot recovery (spec §4.4) — replaces markAllUnfinishedAsFailed. On a
    // fresh process ALL running rows are orphaned (no in-memory owner): requeue
    // those within the attempt budget, terminal-fail the rest, leave queued
    // rows queued.
    async requeueOrphanedRunning(maxAttempts = 2): Promise<{ requeued: number; failed: number }> {
      const requeued = await db
        .update(urlChecks)
        .set({ status: "queued", stage: null, leaseExpiresAt: null })
        .where(and(eq(urlChecks.status, "running"), lt(urlChecks.attempts, maxAttempts)))
        .returning({ id: urlChecks.id });
      const failed = await db
        .update(urlChecks)
        .set({
          status: "failed",
          error: { code: "INTERNAL", message: "stale: process restarted after the retry budget was exhausted" },
          finishedAt: new Date(),
          leaseExpiresAt: null,
        })
        .where(and(eq(urlChecks.status, "running"), gte(urlChecks.attempts, maxAttempts)))
        .returning({ id: urlChecks.id });
      return { requeued: requeued.length, failed: failed.length };
    },
    // Runtime sweeper (spec §4.3) — only reaps running rows whose lease has
    // expired, so a healthy peer's in-flight rows (future lease) are left alone.
    async sweepExpiredLeases(maxAttempts = 2): Promise<{ requeued: number; failed: number }> {
      const expired = sql`${urlChecks.leaseExpiresAt} < now()`;
      const requeued = await db
        .update(urlChecks)
        .set({ status: "queued", stage: null, leaseExpiresAt: null })
        .where(and(eq(urlChecks.status, "running"), lt(urlChecks.attempts, maxAttempts), expired))
        .returning({ id: urlChecks.id });
      const failed = await db
        .update(urlChecks)
        .set({
          status: "failed",
          error: { code: "INTERNAL", message: "stale: lease expired after the retry budget was exhausted" },
          finishedAt: new Date(),
          leaseExpiresAt: null,
        })
        .where(and(eq(urlChecks.status, "running"), gte(urlChecks.attempts, maxAttempts), expired))
        .returning({ id: urlChecks.id });
      return { requeued: requeued.length, failed: failed.length };
    },
    async listActive(): Promise<UrlCheckRow[]> {
      return db
        .select()
        .from(urlChecks)
        .where(inArray(urlChecks.status, ["queued", "running"]))
        .orderBy(urlChecks.createdAt);
    },
    async listByIds(ids: string[]): Promise<UrlCheckRow[]> {
      if (ids.length === 0) return [];
      return db.select().from(urlChecks).where(inArray(urlChecks.id, ids));
    },
    async updateStage(id: string, stage: string): Promise<UrlCheckRow | null> {
      const [updated] = await db.update(urlChecks).set({ stage }).where(eq(urlChecks.id, id)).returning();
      return updated ?? null;
    },
    async complete(
      id: string,
      patch: { jobId: string; alreadyKnown: boolean },
    ): Promise<UrlCheckRow | null> {
      const [updated] = await db
        .update(urlChecks)
        .set({ status: "completed", jobId: patch.jobId, alreadyKnown: patch.alreadyKnown, finishedAt: new Date() })
        .where(eq(urlChecks.id, id))
        .returning();
      return updated ?? null;
    },
    async fail(
      id: string,
      patch: { code: string; message: string; needsText: boolean },
    ): Promise<UrlCheckRow | null> {
      const [updated] = await db
        .update(urlChecks)
        .set({
          status: "failed",
          error: { code: patch.code, message: patch.message },
          needsText: patch.needsText,
          finishedAt: new Date(),
        })
        .where(eq(urlChecks.id, id))
        .returning();
      return updated ?? null;
    },
    async addCost(id: string, usd: number): Promise<UrlCheckRow | null> {
      const [updated] = await db
        .update(urlChecks)
        .set({ costUsd: sql`${urlChecks.costUsd} + ${usd}` })
        .where(eq(urlChecks.id, id))
        .returning();
      return updated ?? null;
    },
    async markAllUnfinishedAsFailed(): Promise<number> {
      const rows = await db
        .update(urlChecks)
        .set({
          status: "failed",
          error: { code: "INTERNAL", message: "stale: process restarted while this check was in progress" },
          finishedAt: new Date(),
        })
        .where(inArray(urlChecks.status, ["queued", "running"]))
        .returning();
      return rows.length;
    },
  };
}

export const urlChecksRepo: ReturnType<typeof createUrlChecksRepo> = {
  insert: (row) => createUrlChecksRepo(getDb()).insert(row),
  getById: (id) => createUrlChecksRepo(getDb()).getById(id),
  updateStage: (id, stage) => createUrlChecksRepo(getDb()).updateStage(id, stage),
  complete: (id, patch) => createUrlChecksRepo(getDb()).complete(id, patch),
  fail: (id, patch) => createUrlChecksRepo(getDb()).fail(id, patch),
  addCost: (id, usd) => createUrlChecksRepo(getDb()).addCost(id, usd),
  markAllUnfinishedAsFailed: () => createUrlChecksRepo(getDb()).markAllUnfinishedAsFailed(),
  claimNextQueued: () => createUrlChecksRepo(getDb()).claimNextQueued(),
  requeueOrphanedRunning: (maxAttempts) => createUrlChecksRepo(getDb()).requeueOrphanedRunning(maxAttempts),
  sweepExpiredLeases: (maxAttempts) => createUrlChecksRepo(getDb()).sweepExpiredLeases(maxAttempts),
  listActive: () => createUrlChecksRepo(getDb()).listActive(),
  listByIds: (ids) => createUrlChecksRepo(getDb()).listByIds(ids),
};
