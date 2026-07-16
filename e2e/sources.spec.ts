import { rmSync } from "node:fs";
import { createClient } from "@libsql/client";
import { expect, request as playwrightRequest, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "../src/server/persistence/schema";
import { E2E_DB_URL } from "./globalSetup";

// Sources page (src/app/sources/page.tsx): GET /api/sources rows "ordered by
// name" (route comment), grouped by persona. Toggle by aria-label rather
// than a hardcoded source name — alphabetical order puts "Ashby" first in
// the remote group, not "Greenhouse" (the one source the fixture connector
// actually yields a posting for), so this never disturbs other specs'
// remote-persona bootstraps.
//
// PATCH /api/sources/[id] requireAdmin()s, but the shared e2e session
// (authSetup.ts) is deliberately role "user" — running every spec as admin
// would mask user-scoping bugs. db:seed:test seeds no admin (unlike
// seed.ts's seedAdmin), and POST /api/auth/register always mints role
// "user" (register/route.ts), so there is no login-as-seeded-admin path:
// this spec registers its own admin account, promotes it via a direct DB
// UPDATE (same @libsql/client connection remote-fit.spec.ts uses), and
// drives the toggle from a dedicated admin browser context/page — the
// shared `page` fixture (e2e-user session) is untouched.
const E2E_ADMIN = { email: "e2e-admin@caliber.test", password: "e2e-admin-password-1" };
const BASE_URL = "http://localhost:3005";
const ADMIN_STORAGE_STATE_PATH = "e2e/.auth/admin.json";

test("sources: persona groups render; first remote source toggle persists across reload", async ({ browser }) => {
  const client = createClient({ url: E2E_DB_URL });
  const db = drizzle(client, { schema });

  const apiContext = await playwrightRequest.newContext({ baseURL: BASE_URL });
  const registerRes = await apiContext.post("/api/auth/register", { data: { ...E2E_ADMIN, inviteCode: "e2e-invite" } });
  if (registerRes.status() === 409) {
    const loginRes = await apiContext.post("/api/auth/login", { data: E2E_ADMIN });
    if (!loginRes.ok()) throw new Error(`admin login fallback failed: ${loginRes.status()} ${await loginRes.text()}`);
  } else if (!registerRes.ok()) {
    throw new Error(`admin register failed: ${registerRes.status()} ${await registerRes.text()}`);
  }

  await db.update(schema.users).set({ role: "admin" }).where(eq(schema.users.email, E2E_ADMIN.email));
  client.close();

  // Registering minted a "user"-role session cookie before the promotion
  // above took effect — log in again so the cookie's session reflects the
  // now-admin row (requireAdmin reads user.role fresh per request, but a
  // stale client-side belief here would be confusing).
  const loginRes = await apiContext.post("/api/auth/login", { data: E2E_ADMIN });
  if (!loginRes.ok()) throw new Error(`admin login failed: ${loginRes.status()} ${await loginRes.text()}`);

  // Post-migration every (app) route redirects a profile-less session to
  // /onboarding (src/app/(app)/layout.tsx) — mirror authSetup.ts's onboarding
  // PUT so this admin session can actually reach /feed and /sources.
  const profileRes = await apiContext.put("/api/profile", {
    data: { baseCountry: "MY", relocation: "stay", scheduleFlex: "base-hours", employmentPref: "any" },
  });
  if (!profileRes.ok()) throw new Error(`admin profile PUT failed: ${profileRes.status()} ${await profileRes.text()}`);

  await apiContext.storageState({ path: ADMIN_STORAGE_STATE_PATH });
  await apiContext.dispose();

  const adminContext = await browser.newContext({ baseURL: BASE_URL, storageState: ADMIN_STORAGE_STATE_PATH });
  const page = await adminContext.newPage();

  try {
    // Enter via the sidebar, not a direct goto — this is the one test in the
    // repo exercising AppShell.tsx's real nav wiring (SidebarNav onSelect ->
    // routeFor["sources"] -> router.push("/sources")). Scoped to the nav
    // landmark (SidebarNav renders a <nav>) so the click can't ever match the
    // /sources page header's own "Sources" text.
    await page.goto("/feed");
    await page.getByRole("navigation").getByRole("button", { name: "Sources" }).click();
    await expect(page).toHaveURL(/\/sources$/);
    await expect(page.locator("header").getByText("Sources")).toBeVisible();

    await expect(page.getByText("Remote · global")).toBeVisible();
    await expect(page.getByText("Malaysia · local")).toBeVisible();

    const toggle = page.getByRole("button", { name: /^Toggle /i }).first();
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveText("Enabled");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    const label = await toggle.getAttribute("aria-label");
    if (!label) throw new Error("first remote source toggle has no aria-label");

    await toggle.click();
    await expect(toggle).toHaveText("Disabled");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");

    await page.reload();
    const toggleAfterReload = page.getByRole("button", { name: label });
    await expect(toggleAfterReload).toHaveText("Disabled");
    await expect(toggleAfterReload).toHaveAttribute("aria-pressed", "false");

    await toggleAfterReload.click();
    await expect(toggleAfterReload).toHaveText("Enabled");
    await expect(toggleAfterReload).toHaveAttribute("aria-pressed", "true");
  } finally {
    await adminContext.close();
    rmSync(ADMIN_STORAGE_STATE_PATH, { force: true });
  }
});
