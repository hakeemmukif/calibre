// Pure eligibility recompute over stored facts (spec 2026-07-12 §5 "explicit
// recompute script, never silent drift"): re-runs the resolver for every job
// using jobs.location + source annotations + the latest score row's jd_facts.
// Zero LLM cost. Run after changing geo.ts tables, priors, or the resolver:
// `npm run eligibility:recompute`.
import { fileURLToPath } from "node:url";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../persistence/db";
import { jobsRepo } from "../persistence/repos/jobs";
import { jobs, jobScores, sources } from "../persistence/schema";
import { profileRepo, ProfileMissingError, type ProfileRow } from "../persistence/repos/profile";
import { parseSourceGeo } from "../search/geo";
import { resolveEligibility } from "./eligibility";
import type { JdFacts } from "./jdFacts";

export async function recomputeEligibility() {
  const db = getDb();
  const rows = await db
    .select({ job: jobs, source: sources })
    .from(jobs)
    .innerJoin(sources, eq(sources.id, jobs.sourceId));

  const profileCache = new Map<string, ProfileRow>();
  let changed = 0;
  let skipped = 0;
  for (const { job, source } of rows) {
    let prof = profileCache.get(job.userId);
    if (!prof) {
      try {
        prof = await profileRepo.get(job.userId);
      } catch (err) {
        if (err instanceof ProfileMissingError) {
          console.warn(`recompute-eligibility: skipping job ${job.id} — owner ${job.userId} has no profile yet`);
          skipped += 1;
          continue;
        }
        throw err;
      }
      profileCache.set(job.userId, prof);
    }

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
      await jobsRepo.updateEligibility(job.id, job.userId, tier, evidence);
      changed += 1;
    }
  }
  return { total: rows.length, changed, skipped };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  recomputeEligibility()
    .then(({ total, changed, skipped }) => {
      console.log(`Recomputed eligibility for ${total} job(s); ${changed} changed, ${skipped} skipped (no profile).`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
