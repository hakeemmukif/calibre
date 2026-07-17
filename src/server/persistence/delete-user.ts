// PDPA delete-user runbook (pre-launch hardening Task 5). Dry-run by default;
// `--confirm` mutates. Deletes one user's entire graph in the 13-table
// FK-safe order, then removes their uploads directory.
//
// Ordered single idempotent statements, NEVER db.transaction() (global
// constraint — the libsql file: driver corrupts under concurrency). A crash
// mid-sequence re-runs cleanly: every delete is a no-op the second time and
// the `users` row goes last, so the CLI email lookup still resolves.
//
// Usage (locally; on the box prefix with `docker compose run --rm app`):
//   npm run user:delete -- someone@example.com            # dry-run: counts only
//   npm run user:delete -- someone@example.com --confirm  # deletes
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { count, eq } from "drizzle-orm";
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { getDb } from "./db";
import {
  applicationAnswers,
  applications,
  correlationReports,
  creditLedger,
  jobScores,
  jobs,
  profile,
  resumes,
  searchRuns,
  sessions,
  tailoredResumes,
  urlChecks,
  users,
} from "./schema";
import type { Db } from "./repos/db";
import { uploadsRoot } from "@/server/resume/uploads";

// FK-safe order (consolidation doc Task 5 — the original 12 + credit_ledger):
// dependents before their targets — applications before tailored_resumes/
// application_answers (applications FKs both), tailored_resumes before
// correlation_reports (report_id FK), every job dependent before jobs,
// search_runs/job_scores before resumes, profile before users. `sources` is
// global — never deleted.
const TABLES: { name: string; table: SQLiteTable; userCol: AnySQLiteColumn }[] = [
  { name: "sessions", table: sessions, userCol: sessions.userId },
  { name: "applications", table: applications, userCol: applications.userId },
  { name: "tailored_resumes", table: tailoredResumes, userCol: tailoredResumes.userId },
  { name: "application_answers", table: applicationAnswers, userCol: applicationAnswers.userId },
  { name: "correlation_reports", table: correlationReports, userCol: correlationReports.userId },
  { name: "job_scores", table: jobScores, userCol: jobScores.userId },
  { name: "credit_ledger", table: creditLedger, userCol: creditLedger.userId },
  { name: "url_checks", table: urlChecks, userCol: urlChecks.userId },
  { name: "search_runs", table: searchRuns, userCol: searchRuns.userId },
  { name: "jobs", table: jobs, userCol: jobs.userId },
  { name: "resumes", table: resumes, userCol: resumes.userId },
  { name: "profile", table: profile, userCol: profile.userId },
  { name: "users", table: users, userCol: users.id },
];

export async function countUserRows(db: Db, userId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const t of TABLES) {
    const [row] = await db.select({ n: count() }).from(t.table).where(eq(t.userCol, userId));
    counts[t.name] = row.n;
  }
  return counts;
}

export async function deleteUser(db: Db, userId: string): Promise<void> {
  for (const t of TABLES) {
    await db.delete(t.table).where(eq(t.userCol, userId));
  }
  await rm(join(uploadsRoot(), userId), { recursive: true, force: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [emailArg, confirmFlag] = process.argv.slice(2);
  if (!emailArg) throw new Error("Usage: npm run user:delete -- <email> [--confirm]");
  const confirm = confirmFlag === "--confirm";
  const db = getDb();
  (async () => {
    const [user] = await db.select().from(users).where(eq(users.email, emailArg.trim().toLowerCase()));
    if (!user) throw new Error(`No user with email ${emailArg}`);
    const counts = await countUserRows(db, user.id);
    console.log(`user ${user.email} (${user.id}) — rows per table:`, counts);
    if (!confirm) {
      console.log("Dry-run only. Re-run with --confirm to delete.");
      process.exit(0);
    }
    await deleteUser(db, user.id);
    console.log(`Deleted ${user.email} and uploads dir ${join(uploadsRoot(), user.id)}.`);
    process.exit(0); // libsql keeps the process alive otherwise (seed.ts idiom)
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
