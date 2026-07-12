import { eq, inArray, sql } from "drizzle-orm";
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
};
