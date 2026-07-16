// Test-profile seed: same four sources as seed.ts, fixture-safe config so
// the CALIBER_TEST_DOUBLES fixture connector has rows to resolve from.
import { fileURLToPath } from "node:url";
import { getDb } from "./db";
import { profile, sources } from "./schema";
import type { Db } from "./repos/db";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

// geo annotations mirror seed.ts's shapes (spec §6): greenhouse "anywhere"
// makes its bare-"Remote" fixture posting classify `anywhere`; lever
// "restricted" keeps its New-York fixture `abroad`; jobstreet country "MY"
// stamps its KL fixture `local`.
export const testSourceSeeds: (typeof sources.$inferInsert)[] = [
  { id: "greenhouse", name: "Greenhouse", kind: "ats", persona: "remote", enabled: true, config: { slug: "fixture", geo: { scope: "anywhere" } } },
  { id: "lever", name: "Lever", kind: "ats", persona: "remote", enabled: true, config: { slug: "fixture", geo: { scope: "restricted" } } },
  { id: "ashby", name: "Ashby", kind: "ats", persona: "remote", enabled: true, config: { slug: "fixture", geo: { scope: "restricted" } } },
  { id: "jobstreet", name: "JobStreet", kind: "board", persona: "local", enabled: true, config: { query: "fixture", country: "MY" } },
  { id: "manual", name: "Manual URL", kind: "manual", persona: "both", enabled: false, config: {} },
];

export async function seedTestSources(db: Db) {
  return db.insert(sources).values(testSourceSeeds).onConflictDoNothing().returning();
}

// Same bootstrap-admin profile row as seed.ts — e2e's scratch DB needs it too.
export async function seedTestProfile(db: Db) {
  return db
    .insert(profile)
    .values({
      id: "default", userId: BOOTSTRAP_ADMIN_ID, baseCountry: "MY", relocation: "stay",
      scheduleFlex: "any-hours", employmentPref: "any",
    })
    .onConflictDoNothing()
    .returning();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = getDb();
  seedTestSources(db)
    .then(async (rows) => {
      const prof = await seedTestProfile(db);
      console.log(`Seeded ${rows.length} test source(s), ${prof.length} profile row(s)`);
      // libsql client needs an explicit exit — process would hang otherwise.
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
