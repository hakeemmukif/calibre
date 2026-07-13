// Measurement gate (spec 2026-07-14-remote-fit-criteria-design.md §11):
// tz_band/hiring_structure distribution over the jobs table — both are
// stated-only (never guessed from location), so near-zero non-null coverage
// after a real scan is the evidence promoting the deep-crawl extractor, not
// optimism. `npm run remote-fit:coverage`.
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { getDb } from "../persistence/db";
import { jobs } from "../persistence/schema";

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
  const [{ n: totalJobs }] = await db.select({ n: sql<number>`count(*)::int` }).from(jobs);
  if (totalJobs === 0) {
    console.log("jobs table is empty — run a scan first.");
    return;
  }

  const bandRows = await db.select({ key: jobs.tzBand, n: sql<number>`count(*)::int` }).from(jobs).groupBy(jobs.tzBand);
  printDistribution("tz_band distribution:", bandRows);

  const structureRows = await db
    .select({ key: jobs.hiringStructure, n: sql<number>`count(*)::int` })
    .from(jobs)
    .groupBy(jobs.hiringStructure);
  printDistribution("hiring_structure distribution:", structureRows);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  report()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
