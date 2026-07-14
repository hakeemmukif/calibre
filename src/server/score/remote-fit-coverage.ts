// Coverage gate (spec 2026-07-14 §11): stated-vs-NULL counts for
// jobs.tz_band/hiring_structure. NULL is a genuine value (nothing stated,
// never gated) — this report exists to tell the operator whether the
// jd-extract template is actually producing these facts often enough for
// the §7 gates to matter. Mirrors eligibility-distribution.ts's shape.
// `npm run remote-fit:coverage`.
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { getDb } from "../persistence/db";
import { jobs } from "../persistence/schema";

async function report() {
  const db = getDb();
  const total = (await db.select({ n: sql<number>`count(*)::int` }).from(jobs))[0].n;
  if (total === 0) {
    console.log("jobs table is empty — run a scan first.");
    return;
  }
  for (const [label, column] of [
    ["tz_band", jobs.tzBand],
    ["hiring_structure", jobs.hiringStructure],
  ] as const) {
    console.log(`${label}:`);
    const rows = await db.select({ value: column, n: sql<number>`count(*)::int` }).from(jobs).groupBy(column);
    for (const r of [...rows].sort((a, b) => b.n - a.n)) {
      const key = r.value ?? "NULL (nothing stated)";
      console.log(`  ${key.padEnd(24)} ${String(r.n).padStart(5)}  ${((r.n / total) * 100).toFixed(1)}%`);
    }
  }
  console.log(`total ${total}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  report()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
