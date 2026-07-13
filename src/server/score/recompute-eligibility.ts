// Pure eligibility recompute over stored facts (spec 2026-07-12 §5 "explicit
// recompute script, never silent drift"): re-runs the resolver for every job
// using jobs.location + source annotations + the latest score row's jd_facts.
// Zero LLM cost. Run after changing geo.ts tables, priors, or the resolver:
// `npm run eligibility:recompute`.
import { fileURLToPath } from "node:url";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../persistence/db";
import { jobs, jobScores, sources } from "../persistence/schema";
import { profileRepo } from "../persistence/repos/profile";
import { parseSourceGeo } from "../search/geo";
import { resolveEligibility } from "./eligibility";
import type { JdFacts } from "./jdFacts";
import { probeTzToken, resolveTzBand } from "./tzBand";

export async function recomputeEligibility() {
  const db = getDb();
  const prof = await profileRepo.get();
  const rows = await db
    .select({ job: jobs, source: sources })
    .from(jobs)
    .innerJoin(sources, eq(sources.id, jobs.sourceId));

  let changed = 0;
  let tzChanged = 0;
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

    // tz_band re-derivation (spec §5): zero-LLM, scavenges a TZ token
    // misfiled in hiringCountries via the non-logging probeTzToken —
    // resolveTzBand would warn on every ordinary country name here.
    // Source is "location", not "stated": hiringCountries holds COUNTRY
    // entries, not a stated TZ requirement — probing with "stated" would
    // enable the bare-code STATED_ONLY tokens (/\b(ET|PT)\b/) against country
    // names, mis-mapping a "PT" (Portugal) hiring-country entry to
    // tz_band=americas (the §14.2 trust-killer inversion). SAFE_TOKENS (the
    // legitimate misfiled entries this scavenge targets) match under either
    // source, so nothing intended is lost.
    const statedTz =
      jdFacts?.tzRequirement ?? (jdFacts?.hiringCountries ?? []).find((c: string) => probeTzToken(c, "location") !== null) ?? null;
    const tz = resolveTzBand({ statedTz, location: job.location || undefined });
    const nextBand = tz?.band ?? null;
    if (nextBand !== job.tzBand) {
      await db.update(jobs).set({ tzBand: nextBand }).where(eq(jobs.id, job.id));
      tzChanged += 1;
    }
  }
  return { total: rows.length, changed, tzChanged };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  recomputeEligibility()
    .then(({ total, changed, tzChanged }) => {
      console.log(`Recomputed eligibility for ${total} job(s); ${changed} changed, ${tzChanged} tz_band changed.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
