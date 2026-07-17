// Measurement gate (spec 2026-07-12 §11): tier distribution over the jobs
// table. If "unknown" dominates (> ~50%), prioritize the phase-2 aggregator
// connector + prior/parser tuning — numbers decide, not optimism.
// `npm run eligibility:report`.
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { getDb } from "../persistence/db";
import { jobs } from "../persistence/schema";

export async function report() {
  const db = getDb();
  const rows = await db
    .select({ eligibility: jobs.eligibility, n: sql<number>`count(*)` })
    .from(jobs)
    .groupBy(jobs.eligibility);
  const total = rows.reduce((s, r) => s + r.n, 0);
  if (total === 0) {
    console.log("jobs table is empty — run a scan first.");
    return;
  }
  for (const r of [...rows].sort((a, b) => b.n - a.n)) {
    console.log(`${r.eligibility.padEnd(9)} ${String(r.n).padStart(5)}  ${((r.n / total) * 100).toFixed(1)}%`);
  }
  console.log(`total     ${String(total).padStart(5)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  report()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
