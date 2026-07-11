// Test-profile seed: same four sources as seed.ts, fixture-safe config so
// the CALIBER_TEST_DOUBLES fixture connector has rows to resolve from.
import { fileURLToPath } from "node:url";
import { getDb } from "./db";
import { sources } from "./schema";
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedTestSources(getDb())
    .then((rows) => {
      console.log(`Seeded ${rows.length} test source(s)`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
