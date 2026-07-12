// Test-profile seed: same four sources as seed.ts, fixture-safe config so
// the CALIBER_TEST_DOUBLES fixture connector has rows to resolve from.
import { fileURLToPath } from "node:url";
import { getDb } from "./db";
import { profile, sources } from "./schema";
import type { Db } from "./repos/db";

export const testSourceSeeds: (typeof sources.$inferInsert)[] = [
  { id: "greenhouse", name: "Greenhouse", kind: "ats", persona: "remote", enabled: true, config: { slug: "fixture" } },
  { id: "lever", name: "Lever", kind: "ats", persona: "remote", enabled: true, config: { slug: "fixture" } },
  { id: "ashby", name: "Ashby", kind: "ats", persona: "remote", enabled: true, config: { slug: "fixture" } },
  { id: "jobstreet", name: "JobStreet", kind: "board", persona: "local", enabled: true, config: { query: "fixture" } },
];

export async function seedTestSources(db: Db) {
  return db.insert(sources).values(testSourceSeeds).onConflictDoNothing().returning();
}

// Same operator-profile singleton as seed.ts — e2e's scratch DB needs it too.
export async function seedTestProfile(db: Db) {
  return db
    .insert(profile)
    .values({ id: "default", baseCountry: "MY", relocation: "stay" })
    .onConflictDoNothing()
    .returning();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = getDb();
  seedTestSources(db)
    .then(async (rows) => {
      const prof = await seedTestProfile(db);
      console.log(`Seeded ${rows.length} test source(s), ${prof.length} profile row(s)`);
      // The postgres-js pool otherwise keeps the tsx process alive forever.
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
