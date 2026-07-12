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
import { profile, sources } from "./schema";
import type { Db } from "./repos/db";

// config.geo.scope / config.country are the eligibility annotations (spec
// 2026-07-12-remote-local-eligibility-design.md §6, operator-confirmed):
// scope "anywhere" = all-remote employer, bare "Remote" reads work-from-
// anywhere; "restricted" = needs JD-level proof, bare "Remote" stays
// unknown; boards carry the country their whole inventory lives in.
export const sourceSeeds: (typeof sources.$inferInsert)[] = [
  { id: "gh-stripe", name: "Stripe", kind: "ats", persona: "remote", enabled: true, config: { connector: "greenhouse", slug: "stripe", geo: { scope: "restricted" } } },
  { id: "gh-gitlab", name: "GitLab", kind: "ats", persona: "remote", enabled: true, config: { connector: "greenhouse", slug: "gitlab", geo: { scope: "anywhere" } } },
  { id: "ashby-ramp", name: "Ramp", kind: "ats", persona: "remote", enabled: true, config: { connector: "ashby", slug: "ramp", geo: { scope: "restricted" } } },
  { id: "ashby-plaid", name: "Plaid", kind: "ats", persona: "remote", enabled: true, config: { connector: "ashby", slug: "plaid", geo: { scope: "restricted" } } },
  { id: "ashby-airwallex", name: "Airwallex", kind: "ats", persona: "remote", enabled: true, config: { connector: "ashby", slug: "airwallex", geo: { scope: "restricted", regions: ["APAC"] } } },
  { id: "ashby-deel", name: "Deel", kind: "ats", persona: "remote", enabled: true, config: { connector: "ashby", slug: "deel", geo: { scope: "anywhere" } } },
  { id: "gh-remote", name: "Remote", kind: "ats", persona: "remote", enabled: true, config: { connector: "greenhouse", slug: "remote", geo: { scope: "anywhere" } } },
  { id: "lever-toptal", name: "Toptal", kind: "ats", persona: "remote", enabled: true, config: { connector: "lever", slug: "toptal", geo: { scope: "anywhere" } } },
  { id: "ashby-elevenlabs", name: "ElevenLabs", kind: "ats", persona: "remote", enabled: true, config: { connector: "ashby", slug: "elevenlabs", geo: { scope: "restricted" } } },
  { id: "ashby-perplexity", name: "Perplexity", kind: "ats", persona: "remote", enabled: true, config: { connector: "ashby", slug: "perplexity", geo: { scope: "restricted" } } },
  { id: "ashby-zapier", name: "Zapier", kind: "ats", persona: "remote", enabled: true, config: { connector: "ashby", slug: "zapier", geo: { scope: "anywhere" } } },
  { id: "ashby-supabase", name: "Supabase", kind: "ats", persona: "remote", enabled: true, config: { connector: "ashby", slug: "supabase", geo: { scope: "anywhere" } } },
  {
    id: "jobstreet", name: "JobStreet Malaysia", kind: "board", persona: "local", enabled: true,
    config: {
      api: "https://my.jobstreet.com/api/jobsearch/v5/search",
      siteKey: "MY-Main",
      query: "software engineer",
      pageSize: 30,
      maxPages: 3,
      country: "MY",
    },
  },
  // Spec 2026-07-12-pasted-job-ingestion-design.md §10: the pasted-URL
  // pipeline's source row — disabled (never fan-out scanned), persona
  // 'both' (visible regardless of active toggle), kind 'manual' (no
  // connector). url-check/run.ts resolves this by id and throws a
  // specific error naming `npm run db:seed` if it's absent.
  { id: "manual", name: "Manual URL", kind: "manual", persona: "both", enabled: false, config: {} },
];

export async function seedSources(db: Db) {
  return db.insert(sources).values(sourceSeeds).onConflictDoNothing().returning();
}

// The operator profile singleton — the seed IS the install step (spec
// 2026-07-12-remote-local-eligibility-design.md §4); runtime never defaults.
export const profileSeed: typeof profile.$inferInsert = {
  id: "default",
  baseCountry: "MY",
  relocation: "stay",
};

export async function seedProfile(db: Db) {
  return db.insert(profile).values(profileSeed).onConflictDoNothing().returning();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = getDb();
  seedSources(db)
    .then(async (rows) => {
      const prof = await seedProfile(db);
      console.log(`Seeded ${rows.length} source(s), ${prof.length} profile row(s)`);
      // The postgres-js pool otherwise keeps the tsx process alive forever.
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
