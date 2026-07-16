import { execSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Local: scratch SQLite file DB under e2e/.scratch (gitignored). CI: the
// workflow sets its own file: scratch path via DATABASE_URL — use it as-is.
const LOCAL_SCRATCH_DB_PATH = resolve(__dirname, ".scratch/caliber-e2e.db");

if (process.env.CI && !process.env.DATABASE_URL) {
  throw new Error("CI is set but DATABASE_URL is not — refusing to guess a connection string.");
}

export const E2E_DB_URL = process.env.CI ? (process.env.DATABASE_URL as string) : `file:${LOCAL_SCRATCH_DB_PATH}`;

export default async function globalSetup() {
  // Drop-and-recreate equivalent for a file DB: delete the file and its WAL
  // sidecars so migrate+seed always start from a clean slate.
  const dbPath = E2E_DB_URL.replace(/^file:/, "");
  mkdirSync(dirname(dbPath), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
  const env = { ...process.env, DATABASE_URL: E2E_DB_URL, CALIBER_TEST_DOUBLES: "1" };
  execSync("npm run db:migrate", { stdio: "inherit", env });
  // seed-test.ts's CLI branch exits deterministically (process.exit) once the
  // insert resolves, so a hang or non-zero exit here is a genuine loud failure.
  execSync("npm run db:seed:test", { stdio: "inherit", env });
}

// NOTE: this module is `require()`-d by playwright.config.ts (for
// E2E_DB_URL) via Playwright's CJS-style config loader, which cannot execute
// `import.meta`-based CLI-trigger code — so the actual CLI entry point lives
// in ./runGlobalSetup.ts, not here. See that file and package.json's
// "pretest:e2e" script for why this doesn't run as a Playwright-native
// globalSetup.
