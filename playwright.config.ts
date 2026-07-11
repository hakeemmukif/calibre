import { defineConfig } from "@playwright/test";
import { E2E_DB_URL } from "./e2e/globalSetup";

export default defineConfig({
  testDir: "./e2e",
  // DB setup (drop/create scratch DB + migrate + seed) runs via the
  // "pretest:e2e" npm hook, not Playwright's own globalSetup — see the
  // comment at the bottom of e2e/globalSetup.ts for why.
  timeout: 60_000,
  use: { baseURL: "http://localhost:3005", trace: "on-first-retry" },
  webServer: {
    command: "npx next dev -p 3005",
    url: "http://localhost:3005/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: { DATABASE_URL: E2E_DB_URL, CALIBER_TEST_DOUBLES: "1", OPENROUTER_API_KEY: "unused-in-doubles-mode" },
  },
});
