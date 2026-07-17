// Measurement gate (spec 2026-07-14-remote-fit-criteria-design.md §11).
// The two facts have DIFFERENT denominators, so they are reported separately:
//  - tz_band is stamped at ingest for EVERY discovered job (location string)
//    and refreshed on the score path, so its honest denominator is all jobs.
//  - hiring_structure is written ONLY on the score path (never location-
//    derivable), so measuring it over all discovered jobs understates it;
//    it is scoped to deep-scored jobs — the only rows that could be populated.
// `npm run remote-fit:coverage`.
import { fileURLToPath } from "node:url";
import { inArray, sql } from "drizzle-orm";
import { getDb } from "../persistence/db";
import { jobs, jobScores } from "../persistence/schema";

function printDistribution(title: string, rows: { key: string | null; n: number }[]) {
  const total = rows.reduce((s, r) => s + r.n, 0);
  console.log(`\n${title}`);
  if (total === 0) {
    console.log("  (no rows)");
    return;
  }
  for (const r of [...rows].sort((a, b) => b.n - a.n)) {
    const label = r.key ?? "null";
    console.log(`  ${label.padEnd(13)} ${String(r.n).padStart(5)}  ${((r.n / total) * 100).toFixed(1)}%`);
  }
  console.log(`  ${"total".padEnd(13)} ${String(total).padStart(5)}`);
}

async function report() {
  const db = getDb();
  const [{ n: totalJobs }] = await db.select({ n: sql<number>`count(*)` }).from(jobs);
  if (totalJobs === 0) {
    console.log("jobs table is empty — run a scan first.");
    return;
  }

  const [{ n: scoredJobs }] = await db
    .select({ n: sql<number>`count(distinct ${jobScores.jobId})` })
    .from(jobScores);
  console.log(`jobs discovered: ${totalJobs}   deep-scored: ${scoredJobs}`);

  const bandRows = await db.select({ key: jobs.tzBand, n: sql<number>`count(*)` }).from(jobs).groupBy(jobs.tzBand);
  printDistribution(`tz_band distribution (over ${totalJobs} discovered jobs):`, bandRows);

  const structureRows = await db
    .select({ key: jobs.hiringStructure, n: sql<number>`count(*)` })
    .from(jobs)
    .where(inArray(jobs.id, db.select({ id: jobScores.jobId }).from(jobScores)))
    .groupBy(jobs.hiringStructure);
  printDistribution(`hiring_structure distribution (over ${scoredJobs} deep-scored jobs):`, structureRows);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  report()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
