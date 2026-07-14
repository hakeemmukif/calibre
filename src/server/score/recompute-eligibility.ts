// Pure eligibility recompute over stored facts (spec 2026-07-12 §5 "explicit
// recompute script, never silent drift"): re-runs the resolver for every job
// using jobs.location + source annotations + the latest score row's jd_facts.
// Zero LLM cost. Run after changing geo.ts tables, priors, or the resolver:
// `npm run eligibility:recompute`.
import { fileURLToPath } from "node:url";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../persistence/db";
import { jobs, jobScores, sources } from "../persistence/schema";
import { BOOTSTRAP_ADMIN_ID } from "../auth/ids";
import { profileRepo } from "../persistence/repos/profile";
import { parseSourceGeo } from "../search/geo";
import { resolveEligibility } from "./eligibility";
import type { JdFacts } from "./jdFacts";

export async function recomputeEligibility() {
  const db = getDb();
  // TEMP read-scaffold: this CLI script (`npm run eligibility:recompute`)
  // has no session and recomputes across ALL jobs regardless of owner —
  // scoped per-user profile lookup lands with the jobs read-scoping task.
  const prof = await profileRepo.get(BOOTSTRAP_ADMIN_ID);
  const rows = await db
    .select({ job: jobs, source: sources })
    .from(jobs)
    .innerJoin(sources, eq(sources.id, jobs.sourceId));

  let changed = 0;
  for (const { job, source } of rows) {
    const [latestScore] = await db
      .select({ jdFacts: jobScores.jdFacts })
      .from(jobScores)
      .where(eq(jobScores.jobId, job.id))
      .orderBy(desc(jobScores.createdAt), desc(jobScores.id))
      .limit(1);
    const jdFacts = (latestScore?.jdFacts ?? undefined) as JdFacts | undefined;
    const { tier, evidence } = resolveEligibility({
      baseCountry: prof.baseCountry,
      sourceKind: source.kind,
      sourceGeo: parseSourceGeo(source),
      location: job.location || undefined,
      jdFacts,
    });
    if (tier !== job.eligibility || evidence !== job.eligibilityEvidence) {
      await db.update(jobs).set({ eligibility: tier, eligibilityEvidence: evidence }).where(eq(jobs.id, job.id));
      changed += 1;
    }
  }
  return { total: rows.length, changed };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  recomputeEligibility()
    .then(({ total, changed }) => {
      console.log(`Recomputed eligibility for ${total} job(s); ${changed} changed.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
