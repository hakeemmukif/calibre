// `sources` seed — one row per company (system-architecture.md §1/§3), so
// each ATS connector (greenhouse/lever/ashby) can fan out across many
// employers. `config.connector` is the FACTORIES discriminator that
// connectors/index.ts resolves (falling back to `id` for canonical
// single-board rows); `id`/`config.slug` come verbatim from career-ops/
// portals.yml's tracked_companies careers_url values (donor is a slug
// reference only, never a runtime dependency). jobstreet is the MY-board
// connector (persona 'local'), live-verified in Step 8 of task-2-brief.md.
import { fileURLToPath } from "node:url";
import { getDb } from "./db";
import { sources } from "./schema";
import type { Db } from "./repos/db";

export const sourceSeeds: (typeof sources.$inferInsert)[] = [
  { id: "gh-stripe", name: "Stripe", kind: "ats", persona: "remote", enabled: true, config: { connector: "greenhouse", slug: "stripe" } },
  { id: "gh-gitlab", name: "GitLab", kind: "ats", persona: "remote", enabled: true, config: { connector: "greenhouse", slug: "gitlab" } },
  { id: "ashby-ramp", name: "Ramp", kind: "ats", persona: "remote", enabled: true, config: { connector: "ashby", slug: "ramp" } },
  { id: "ashby-plaid", name: "Plaid", kind: "ats", persona: "remote", enabled: true, config: { connector: "ashby", slug: "plaid" } },
  { id: "ashby-airwallex", name: "Airwallex", kind: "ats", persona: "remote", enabled: true, config: { connector: "ashby", slug: "airwallex" } },
  { id: "ashby-deel", name: "Deel", kind: "ats", persona: "remote", enabled: true, config: { connector: "ashby", slug: "deel" } },
  { id: "gh-remote", name: "Remote", kind: "ats", persona: "remote", enabled: true, config: { connector: "greenhouse", slug: "remote" } },
  { id: "lever-toptal", name: "Toptal", kind: "ats", persona: "remote", enabled: true, config: { connector: "lever", slug: "toptal" } },
  { id: "ashby-elevenlabs", name: "ElevenLabs", kind: "ats", persona: "remote", enabled: true, config: { connector: "ashby", slug: "elevenlabs" } },
  { id: "ashby-perplexity", name: "Perplexity", kind: "ats", persona: "remote", enabled: true, config: { connector: "ashby", slug: "perplexity" } },
  { id: "ashby-zapier", name: "Zapier", kind: "ats", persona: "remote", enabled: true, config: { connector: "ashby", slug: "zapier" } },
  { id: "ashby-supabase", name: "Supabase", kind: "ats", persona: "remote", enabled: true, config: { connector: "ashby", slug: "supabase" } },
  {
    id: "jobstreet", name: "JobStreet Malaysia", kind: "board", persona: "local", enabled: true,
    config: {
      api: "https://my.jobstreet.com/api/jobsearch/v5/search",
      siteKey: "MY-Main",
      query: "software engineer",
      pageSize: 30,
      maxPages: 3,
    },
  },
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
