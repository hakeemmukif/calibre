import { rmSync } from "node:fs";
import { createClient } from "@libsql/client";
import { expect, request as playwrightRequest, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "../src/server/persistence/schema";
import { E2E_DB_URL } from "./globalSetup";

// Credits e2e (membership-credits spec §5's deliberate substitute for a full
// golden-path run — see task-11 brief: that run is LLM-bound and
// nondeterministic, so the 26-credit total is pinned piecewise at
// unit/route level elsewhere and this spec covers the wire-to-UI 402
// behavior deterministically instead). Registers its own FRESH user rather
// than reusing the shared authSetup.ts session — that user is exercised by
// every other spec file in this run and its balance is not pristine by the
// time this spec runs, but the signup bundle's exact 30-credit balance is
// exactly what this spec needs to observe.
const BASE_URL = "http://localhost:3005";
const NEW_USER_STORAGE_STATE_PATH = "e2e/.auth/credits-user.json";

// db:seed:test creates no `users` row (seed-test.ts never inserts one — see
// sources.spec.ts's comment) and POST /api/auth/register always mints role
// "user" (register/route.ts), so there is no seeded-admin login path: like
// sources.spec.ts, this spec registers its own admin account and promotes
// it via a direct DB UPDATE. A distinct, timestamped email from
// sources.spec.ts's fixed E2E_ADMIN so the two specs never collide
// regardless of file run order.
const ADMIN = { email: `credits-e2e-admin-${Date.now()}@caliber.test`, password: "e2e-credits-admin-password-1" };
const NEW_USER = { email: `credits-e2e-user-${Date.now()}@caliber.test`, password: "e2e-credits-user-password-1" };

test("credits: signup bundle shows in the chip; an admin drain surfaces the insufficient-credits dialog", async ({
  browser,
}) => {
  const client = createClient({ url: E2E_DB_URL });
  const db = drizzle(client, { schema });

  const userContext = await playwrightRequest.newContext({ baseURL: BASE_URL });
  const registerRes = await userContext.post("/api/auth/register", {
    data: { ...NEW_USER, inviteCode: "e2e-invite" },
  });
  if (!registerRes.ok()) {
    throw new Error(`credits e2e: register failed: ${registerRes.status()} ${await registerRes.text()}`);
  }
  const { user } = (await registerRes.json()) as { user: { id: string } };

  const profileRes = await userContext.put("/api/profile", {
    data: { baseCountry: "MY", relocation: "stay", scheduleFlex: "base-hours", employmentPref: "any" },
  });
  if (!profileRes.ok()) {
    throw new Error(`credits e2e: PUT /api/profile failed: ${profileRes.status()} ${await profileRes.text()}`);
  }

  // "Scan now" (src/server/search/run.ts's startSearch) throws
  // NoActiveResumeError BEFORE it ever reaches assertAndDebit — a
  // résumé-less account 409s regardless of credit balance, never surfacing
  // the 402 this test is after. Insert an active résumé directly via DB
  // (bypassing POST /api/resume, which itself debits 3 "resume" credits) so
  // the signup bundle stays exactly 30 for the first assertion below.
  await db.insert(schema.resumes).values({
    userId: user.id,
    rawText: "Jane Doe — Software Engineer",
    structured: {
      storeVersion: 2,
      extractionPath: "text",
      name: "Jane Doe",
      contact: [],
      experience: [],
      education: [],
      skills: [],
      projects: [],
      certifications: [],
      languages: [],
      sections: [],
    },
    sourceKind: "paste",
    isActive: true,
  });

  await userContext.storageState({ path: NEW_USER_STORAGE_STATE_PATH });
  await userContext.dispose();

  const userBrowserContext = await browser.newContext({ baseURL: BASE_URL, storageState: NEW_USER_STORAGE_STATE_PATH });
  const page = await userBrowserContext.newPage();

  try {
    // CreditsChip (src/app/AppShell.tsx) refreshes on mount and renders
    // "⬡ {balance} credits" once the fetch resolves.
    await page.goto("/feed");
    await expect(page.getByText("⬡ 30 credits")).toBeVisible();

    const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL });
    const adminRegisterRes = await adminContext.post("/api/auth/register", {
      data: { ...ADMIN, inviteCode: "e2e-invite" },
    });
    if (!adminRegisterRes.ok()) {
      throw new Error(`credits e2e: admin register failed: ${adminRegisterRes.status()} ${await adminRegisterRes.text()}`);
    }
    await db.update(schema.users).set({ role: "admin" }).where(eq(schema.users.email, ADMIN.email));
    // Registering minted a "user"-role session cookie before the promotion
    // above took effect — log in again so the cookie's session reflects the
    // now-admin row (mirrors sources.spec.ts's identical admin-promotion idiom).
    const adminLoginRes = await adminContext.post("/api/auth/login", { data: ADMIN });
    if (!adminLoginRes.ok()) {
      throw new Error(`credits e2e: admin login failed: ${adminLoginRes.status()} ${await adminLoginRes.text()}`);
    }

    const drainRes = await adminContext.post(`/api/admin/users/${user.id}/credits`, { data: { delta: -30 } });
    if (!drainRes.ok()) {
      throw new Error(`credits e2e: admin credit drain failed: ${drainRes.status()} ${await drainRes.text()}`);
    }
    await adminContext.dispose();

    await page.reload();
    await expect(page.getByText("⬡ 0 credits")).toBeVisible();

    // "Scan now" -> POST /api/search -> 402 INSUFFICIENT_CREDITS (feature
    // "scan", 10 credits) -> feed/page.tsx's showDenial() ->
    // InsufficientCreditsDialog renders "{label} cost{s} {required} credits
    // — you have {balance}." verbatim.
    await page.getByRole("button", { name: "Scan now" }).click();
    await expect(page.getByText("Scans cost 10 credits — you have 0.")).toBeVisible();
  } finally {
    await userBrowserContext.close();
    rmSync(NEW_USER_STORAGE_STATE_PATH, { force: true });
    client.close();
  }
});
