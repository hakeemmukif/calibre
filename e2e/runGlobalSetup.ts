// CLI entry point for e2e/globalSetup.ts, run via the "pretest:e2e" npm
// hook (package.json) before "playwright test" is invoked at all.
//
// Verified against playwright@1.61.1 (node_modules/playwright/lib/runner/
// index.js, createGlobalSetupTasks): WebServerPlugin.setup() — which spawns
// `next dev` and waits for it to become healthy — runs in the same task
// batch *before* config.globalSetups. So wiring globalSetup.ts as
// Playwright's own `globalSetup` config option runs too late: `next dev`'s
// instrumentation hook queries the DB at boot and crashes the whole process
// (unmigrated/missing scratch DB) before Playwright's globalSetup task
// would ever fire. Running it as an npm pretest step
// instead guarantees the DB exists before the webServer starts.
import globalSetup from "./globalSetup";

globalSetup().catch((err) => {
  console.error(err);
  process.exit(1);
});
