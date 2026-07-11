import { execSync } from "node:child_process";

// Local: scratch DB on the native Postgres. CI: the workflow's service
// container provides DATABASE_URL — use it as-is (drop/create is the
// container's job there; it starts empty).
if (process.env.CI && !process.env.DATABASE_URL) {
  throw new Error("CI is set but DATABASE_URL is not — refusing to guess a connection string.");
}

export const E2E_DB_URL = process.env.CI
  ? (process.env.DATABASE_URL as string)
  : "postgresql://localhost:5432/caliber_e2e";

export default async function globalSetup() {
  if (!process.env.CI) {
    execSync(`psql -d postgres -c "DROP DATABASE IF EXISTS caliber_e2e" -c "CREATE DATABASE caliber_e2e"`, {
      stdio: "inherit",
    });
  }
  const env = { ...process.env, DATABASE_URL: E2E_DB_URL, CALIBER_TEST_DOUBLES: "1" };
  execSync("npm run db:migrate", { stdio: "inherit", env });

  // seed-test.ts opens a `postgres` client and never calls `.end()`, so the
  // open TCP connection keeps the tsx/node process alive after the insert
  // has already committed and "Seeded N test source(s)" has printed
  // (confirmed empirically: the process idles indefinitely post-log with no
  // further work pending — seeding 4 rows itself takes well under 1s).
  // execSync's own `timeout` kills it once the seed is done; a real seed
  // failure still throws with a non-zero exit before the timeout fires, so
  // this stays fail-loud for actual errors.
  try {
    execSync("npm run db:seed:test", { stdio: "inherit", env, timeout: 8_000 });
  } catch (err) {
    // Confirmed empirically: execSync's timeout surfaces as `code: "ETIMEDOUT"`
    // here (spawned via `/bin/sh -c`), not a SIGTERM `signal` on the error.
    const timedOut = (err as NodeJS.ErrnoException).code === "ETIMEDOUT";
    if (!timedOut) throw err;
  }
}

// NOTE: this module is `require()`-d by playwright.config.ts (for
// E2E_DB_URL) via Playwright's CJS-style config loader, which cannot execute
// `import.meta`-based CLI-trigger code — so the actual CLI entry point lives
// in ./runGlobalSetup.ts, not here. See that file and package.json's
// "pretest:e2e" script for why this doesn't run as a Playwright-native
// globalSetup.
