import { and, eq, or } from "drizzle-orm";
import { getDb } from "../db";
import { sources } from "../schema";
import type { Db } from "./db";

export type NewSource = typeof sources.$inferInsert;
export type SourceRow = typeof sources.$inferSelect;

export function createSourcesRepo(db: Db) {
  return {
    async insert(row: NewSource): Promise<SourceRow> {
      const [inserted] = await db.insert(sources).values(row).returning();
      return inserted;
    },
    async getById(id: string): Promise<SourceRow | null> {
      const [row] = await db.select().from(sources).where(eq(sources.id, id)).limit(1);
      return row ?? null;
    },
    // §3 PersonaToggle: `sources WHERE persona IN (active, 'both') AND enabled`
    async listEnabledByPersona(persona: "remote" | "local"): Promise<SourceRow[]> {
      return db
        .select()
        .from(sources)
        .where(and(eq(sources.enabled, true), or(eq(sources.persona, persona), eq(sources.persona, "both"))));
    },
  };
}

export const sourcesRepo: ReturnType<typeof createSourcesRepo> = {
  insert: (row) => createSourcesRepo(getDb()).insert(row),
  getById: (id) => createSourcesRepo(getDb()).getById(id),
  listEnabledByPersona: (persona) => createSourcesRepo(getDb()).listEnabledByPersona(persona),
};
