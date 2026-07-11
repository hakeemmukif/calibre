// `sources` seed — the four v1 connectors (system-architecture.md §1/§3):
// greenhouse/lever/ashby are global ATS aggregators (persona 'remote');
// jobstreet is the first MY-board connector (persona 'local'). `config` slugs
// are placeholders — replace before running a real search.
import { fileURLToPath } from "node:url";
import { getDb } from "./db";
import { sources } from "./schema";
import type { Db } from "./repos/db";

export const sourceSeeds: (typeof sources.$inferInsert)[] = [
  { id: "greenhouse", kind: "ats", persona: "remote", enabled: true, config: { slug: "REPLACE_ME" } },
  { id: "lever", kind: "ats", persona: "remote", enabled: true, config: { slug: "REPLACE_ME" } },
  { id: "ashby", kind: "ats", persona: "remote", enabled: true, config: { slug: "REPLACE_ME" } },
  { id: "jobstreet", kind: "board", persona: "local", enabled: true, config: { query: "REPLACE_ME" } },
];

export async function seedSources(db: Db) {
  return db.insert(sources).values(sourceSeeds).onConflictDoNothing().returning();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedSources(getDb())
    .then((rows) => {
      console.log(`Seeded ${rows.length} source(s)`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
