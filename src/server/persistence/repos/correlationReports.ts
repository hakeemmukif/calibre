import { and, eq } from "drizzle-orm";
import { getDb } from "../db";
import { correlationReports } from "../schema";
import type { Db } from "./db";

export type NewCorrelationReport = typeof correlationReports.$inferInsert;
export type CorrelationReportRow = typeof correlationReports.$inferSelect;

export function createCorrelationReportsRepo(db: Db) {
  return {
    async insert(row: NewCorrelationReport): Promise<CorrelationReportRow> {
      const [inserted] = await db.insert(correlationReports).values(row).returning();
      return inserted;
    },
    async getById(id: string, userId: string): Promise<CorrelationReportRow | null> {
      const [row] = await db.select().from(correlationReports)
        .where(and(eq(correlationReports.id, id), eq(correlationReports.userId, userId)));
      return row ?? null;
    },
    // GLOBAL-BY-DECISION: async correlation-report job's own status write —
    // `id` is the row this same process just inserted, never an
    // attacker-supplied route param, so there is no separate tenant to scope
    // against here (mirrors tailoredResumes.ts's updateStatus).
    async updateStatus(id: string, status: CorrelationReportRow["status"]): Promise<CorrelationReportRow | null> {
      const [updated] = await db.update(correlationReports).set({ status })
        .where(eq(correlationReports.id, id)).returning();
      return updated ?? null;
    },
    // GLOBAL-BY-DECISION: same as updateStatus above — internal job-engine
    // completion write keyed on a row this process already owns.
    async complete(id: string, patch: {
      rows: CorrelationReportRow["rows"]; semantic: CorrelationReportRow["semantic"];
      ats: CorrelationReportRow["ats"]; model: string; costUsd: number; completedAt: Date;
    }): Promise<CorrelationReportRow | null> {
      const [updated] = await db.update(correlationReports)
        .set({ ...patch, status: "completed" })
        .where(eq(correlationReports.id, id)).returning();
      return updated ?? null;
    },
    // GLOBAL-BY-DECISION: crash-safety write, same as tailoredResumes.ts's
    // markFailed — an unexpected error during the async job flips the row to
    // 'failed' via a row this process itself just created.
    async markFailed(id: string): Promise<CorrelationReportRow | null> {
      const [updated] = await db.update(correlationReports).set({ status: "failed" })
        .where(eq(correlationReports.id, id)).returning();
      return updated ?? null;
    },
  };
}

export const correlationReportsRepo: ReturnType<typeof createCorrelationReportsRepo> = {
  insert: (row) => createCorrelationReportsRepo(getDb()).insert(row),
  getById: (id, userId) => createCorrelationReportsRepo(getDb()).getById(id, userId),
  updateStatus: (id, status) => createCorrelationReportsRepo(getDb()).updateStatus(id, status),
  complete: (id, patch) => createCorrelationReportsRepo(getDb()).complete(id, patch),
  markFailed: (id) => createCorrelationReportsRepo(getDb()).markFailed(id),
};
