// Test-profile seed: same four sources as seed.ts, fixture-safe config
// matching the (now-dead post-P.5-cutover, kept for backlog) CALIBER_TEST_DOUBLES
// fixture connector's source ids. Also seeds the postings pool directly
// (search/run.ts's P.5 pool-read has no connector fan-out anymore) with the
// same three postings that connector used to discover.
import { fileURLToPath } from "node:url";
import { getDb } from "./db";
import { crawlRuns, postings, profile, sources } from "./schema";
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

// Global postings pool rows (P.5 cutover) — same "Senior Backend Engineer,
// Payments" / Jane Doe universe the dead fixture connector
// (src/server/search/connectors/fixture.ts) used to discover live, now
// seeded directly since search/run.ts reads only from `postings`. Shape
// mirrors search/run.test.ts's insertPosting helper (canonicalKey, url,
// sourceId, title, company, location, persona, description, aliases: [],
// raw: {}). persona is copied from each row's source above: greenhouse/lever
// "remote", jobstreet "local".
export const testPostingSeeds: (typeof postings.$inferInsert)[] = [
  {
    canonicalKey: "e2e:greenhouse:grab-payments",
    url: "https://boards.greenhouse.io/grab/jobs/6041234",
    sourceId: "greenhouse",
    title: "Senior Backend Engineer, Payments",
    company: "Grab",
    location: "Remote",
    description: "Own the payments ledger service. Stack: Node.js, Kafka, Postgres. Payments domain experience valued.",
    persona: "remote",
    aliases: [],
    raw: {},
  },
  {
    canonicalKey: "e2e:jobstreet:local-fintech-payments",
    url: "https://www.jobstreet.com.my/job/senior-backend-engineer-payments-991234",
    sourceId: "jobstreet",
    title: "Senior Backend Engineer, Payments",
    company: "Local Fintech Sdn Bhd",
    location: "Kuala Lumpur, Malaysia",
    description: "Build the merchant payments platform. Stack: Node.js, Postgres. Payments domain experience valued.",
    persona: "local",
    aliases: [],
    raw: {},
  },
  {
    // The e2e abroad case (profile.spec.ts §8 journey): New York onsite on a
    // restricted-prior source classifies `abroad` — hidden under relocation
    // "stay", revealed under "open".
    canonicalKey: "e2e:lever:acme-us-payments",
    url: "https://jobs.lever.co/acme/senior-backend-engineer-payments",
    sourceId: "lever",
    title: "Senior Backend Engineer, Payments",
    company: "Acme US",
    location: "New York, NY",
    description: "Payments platform team. Stack: Node.js, Postgres. Onsite in New York. Payments domain experience valued.",
    persona: "remote",
    aliases: [],
    raw: {},
  },
];

export async function seedTestPostings(db: Db) {
  return db.insert(postings).values(testPostingSeeds).onConflictDoNothing().returning();
}

// F4 staleness gate (search/run.ts's emitCrawlStalenessWarning): without a
// recent completed crawl_runs row, every e2e scan emits a "Pool freshness
// unknown" warning on the SSE. Harmless to spec assertions (no spec checks
// for its absence) but a fresh row keeps the doubles environment realistic.
export async function seedTestCrawlRun(db: Db) {
  return db.insert(crawlRuns).values({ status: "completed", finishedAt: new Date() }).returning();
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
      const posts = await seedTestPostings(db);
      const crawl = await seedTestCrawlRun(db);
      const prof = await seedTestProfile(db);
      console.log(
        `Seeded ${rows.length} test source(s), ${posts.length} posting(s), ${crawl.length} crawl run(s), ${prof.length} profile row(s)`,
      );
      // libsql client needs an explicit exit — process would hang otherwise.
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
