import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import { E2E_DB_URL } from "./e2e/globalSetup";

export default defineConfig({
  testDir: "./e2e",
  // DB setup (drop/create scratch DB + migrate + seed) runs via the
  // "pretest:e2e" npm hook, not Playwright's own globalSetup — see the
  // comment at the bottom of e2e/globalSetup.ts for why.
  timeout: 60_000,
  // All spec files share one `next dev` process and one scratch DB (the
  // webServer above is started once for the whole run). That process holds
  // GLOBAL mutable state a test run must not race against: a single active
  // résumé row (resumes.isActive) and an in-memory per-persona active-run
  // lock (src/server/runs/registry.ts, guarding POST /api/search). Two spec
  // files concurrently starting a "remote" persona search would 409 one of
  // them (ActiveRunConflictError) and can leave a page's scan-handoff
  // subscribing to nothing — a real correctness bug, not a perf tuning
  // knob. Serializing is the fix; nothing in this suite is slow enough to
  // need parallelism.
  workers: 1,
  // Runs after the webServer is healthy (see e2e/authSetup.ts's top
  // comment) — registers/logs in a fixed e2e user, onboards a profile, and
  // writes e2e/.auth/user.json. Every project's `use.storageState` below
  // points at that file so every spec starts signed-in + onboarded, since
  // post-migration ALL (app) routes redirect a session-less or profile-less
  // request to /login or /onboarding instead of rendering.
  globalSetup: "./e2e/authSetup.ts",
  use: { baseURL: "http://localhost:3005", trace: "on-first-retry", storageState: "./e2e/.auth/user.json" },
  webServer: {
    command: "npx next dev -p 3005",
    url: "http://localhost:3005/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: E2E_DB_URL,
      CALIBER_TEST_DOUBLES: "1",
      OPENROUTER_API_KEY: "unused-in-doubles-mode",
      CALIBER_UPLOADS_DIR: process.env.CALIBER_UPLOADS_DIR ?? join(tmpdir(), "caliber-e2e-uploads"),
      // http-only local dev server, no TLS — session cookies must not
      // require `secure` or the auth flow in e2e/authSetup.ts can't work.
      SESSION_COOKIE_SECURE: "false",
      // Unused by db:seed:test (seed-test.ts never creates a users row —
      // e2e/authSetup.ts registers its own test user via the API instead),
      // but reserved here so `npm run db:seed` also works against this
      // webServer env if a future admin-flow spec switches to it.
      ADMIN_EMAIL: process.env.ADMIN_EMAIL ?? "e2e-admin@caliber.test",
      ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? "e2e-admin-password-1",
      // Registration is invite-gated (membership spec §4.5.2) — every spec
      // that calls POST /api/auth/register must send this value as
      // `inviteCode`, or the route 403s.
      CALIBER_INVITE_CODE: "e2e-invite",
    },
  },
});
