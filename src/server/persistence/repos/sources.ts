import { and, asc, eq, or } from "drizzle-orm";
import type { ScanPersona } from "@/types";
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
    // Task 2.5 bulk-seed: mirrors `insert` above (`db.insert(sources)
    // .values(...).returning()`), plus `onConflictDoNothing()` — same
    // pattern seed.ts's `seedSources` already uses on `id` (the primary
    // key) — so a re-run of the engine never overwrites a row an admin or
    // an earlier run already seeded.
    async bulkInsert(rows: NewSource[]): Promise<SourceRow[]> {
      return db.insert(sources).values(rows).onConflictDoNothing().returning();
    },
    // GLOBAL-BY-DECISION: sources are admin-managed reference data, not
    // user-owned (Step 3 plan Global Constraints: "sources reads stay
    // global") — no userId dimension exists on this table.
    async getById(id: string): Promise<SourceRow | null> {
      const [row] = await db.select().from(sources).where(eq(sources.id, id)).limit(1);
      return row ?? null;
    },
    // §3 PersonaToggle: `sources WHERE persona IN (active, 'both') AND enabled`
    // GLOBAL-BY-DECISION: sources are admin-managed reference data, not
    // user-owned — same as getById above.
    async listEnabledByPersona(persona: ScanPersona): Promise<SourceRow[]> {
      return db
        .select()
        .from(sources)
        .where(and(eq(sources.enabled, true), or(eq(sources.persona, persona), eq(sources.persona, "both"))));
    },
    // Sources management page: every row, both personas, disabled included.
    // GLOBAL-BY-DECISION: sources are admin-managed reference data — this
    // intentionally has no WHERE at all, global by design.
    async listAll(): Promise<SourceRow[]> {
      return db.select().from(sources).orderBy(asc(sources.name));
    },
    // GLOBAL-BY-DECISION: sources are admin-managed reference data, not
    // user-owned — same as getById above. TODO(step 6/7): once requireAdmin()
    // lands, the PATCH route should gate on it (see app/api/sources/[id]).
    async setEnabled(id: string, enabled: boolean): Promise<SourceRow | undefined> {
      const [updated] = await db.update(sources).set({ enabled }).where(eq(sources.id, id)).returning();
      return updated;
    },
    // Task 2.6 freshness loop: config rewrite (health fields, ATS re-detection)
    // + enabled flip in one statement. Mirrors setEnabled above; undefined on
    // an unknown id, same as setEnabled.
    // GLOBAL-BY-DECISION: sources are admin-managed reference data, not
    // user-owned — same as getById above.
    async update(
      id: string,
      patch: Partial<Pick<NewSource, "config" | "enabled">>,
    ): Promise<SourceRow | undefined> {
      const [updated] = await db.update(sources).set(patch).where(eq(sources.id, id)).returning();
      return updated;
    },
  };
}

export const sourcesRepo: ReturnType<typeof createSourcesRepo> = {
  insert: (row) => createSourcesRepo(getDb()).insert(row),
  bulkInsert: (rows) => createSourcesRepo(getDb()).bulkInsert(rows),
  getById: (id) => createSourcesRepo(getDb()).getById(id),
  listEnabledByPersona: (persona) => createSourcesRepo(getDb()).listEnabledByPersona(persona),
  listAll: () => createSourcesRepo(getDb()).listAll(),
  setEnabled: (id, enabled) => createSourcesRepo(getDb()).setEnabled(id, enabled),
  update: (id, patch) => createSourcesRepo(getDb()).update(id, patch),
};
