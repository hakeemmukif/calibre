import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { request } from "@playwright/test";

// Wired as Playwright's native `globalSetup` config option (NOT the
// "pretest:e2e" npm hook that e2e/globalSetup.ts/runGlobalSetup.ts use for
// DB provisioning). Per the ordering documented at the bottom of
// e2e/globalSetup.ts (verified against playwright@1.61.1's
// WebServerPlugin.setup()), Playwright's `config.globalSetups` run AFTER
// the webServer task batch has already started `next dev` and confirmed it
// healthy — so this function can safely make real HTTP requests against the
// running server. DB seeding still can't live here (it must exist before
// `next dev` boots, per that same comment), so the split stands: DB via
// pretest, auth via this file.
export const E2E_USER = { email: "e2e-user@caliber.test", password: "e2e-test-password-1" };
export const STORAGE_STATE_PATH = "e2e/.auth/user.json";
const BASE_URL = "http://localhost:3005";

// Post-migration every (app) route requires BOTH a session AND a profile
// row (src/app/(app)/layout.tsx redirects profile-less sessions to
// /onboarding instead of rendering /feed etc.) — so a spec that just
// `page.goto("/feed")`s needs a session that is already onboarded, not just
// logged in. This registers a fixed e2e test user (falling back to login if
// a prior run already created it — the scratch DB is dropped/recreated by
// the pretest hook, but this stays robust if that ever changes) and then
// PUTs a profile to onboard it before saving storageState.
export default async function globalSetup() {
  const context = await request.newContext({ baseURL: BASE_URL });

  const registerRes = await context.post("/api/auth/register", { data: E2E_USER });
  if (registerRes.status() === 409) {
    const loginRes = await context.post("/api/auth/login", { data: E2E_USER });
    if (!loginRes.ok()) {
      throw new Error(`authSetup: login fallback failed: ${loginRes.status()} ${await loginRes.text()}`);
    }
  } else if (!registerRes.ok()) {
    throw new Error(`authSetup: register failed: ${registerRes.status()} ${await registerRes.text()}`);
  }

  const profileRes = await context.put("/api/profile", { data: { baseCountry: "MY", relocation: "stay" } });
  if (!profileRes.ok()) {
    throw new Error(`authSetup: PUT /api/profile failed: ${profileRes.status()} ${await profileRes.text()}`);
  }

  mkdirSync(dirname(STORAGE_STATE_PATH), { recursive: true });
  await context.storageState({ path: STORAGE_STATE_PATH });
  await context.dispose();
}
