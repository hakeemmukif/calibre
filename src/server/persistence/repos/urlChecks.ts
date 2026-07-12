import { eq } from "drizzle-orm";
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
  };
}

export const urlChecksRepo: Pick<ReturnType<typeof createUrlChecksRepo>, "insert" | "getById"> = {
  insert: (row) => createUrlChecksRepo(getDb()).insert(row),
  getById: (id) => createUrlChecksRepo(getDb()).getById(id),
};
