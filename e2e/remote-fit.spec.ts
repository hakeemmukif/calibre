import { createClient } from "@libsql/client";
import { expect, test } from "@playwright/test";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { insertJob, insertJobScore } from "../src/server/persistence/repos/__fixtures__/helpers";
import * as schema from "../src/server/persistence/schema";
import { E2E_USER } from "./authSetup";
import { E2E_DB_URL } from "./globalSetup";

// Remote-fit dial-flip journey (spec 2026-07-14-remote-fit-criteria-design.md
// §7/§8/§11), the tz_band sibling of profile.spec.ts's relocation-flip
// journey: flipping the schedule dial re-scopes the feed with zero rescan.
// Jobs are seeded directly with a job_scores row (not via the scan-doubles
// fixtures, which carry no tz_band control) — every feed/detail query
// inner-joins job_scores, so an unscored job never appears (jobsRepo.listScored).
const SAMPLE_RESUME = "Jane Doe\nSenior Backend Engineer\nPayments, Node.js, Postgres\n" + "x".repeat(120);

// Superseded by DECISION A (operator, 2026-07-17, full soft rank — see
// docs/superpowers/plans/2026-07-17-global-postings-pool-build.md
// "DECISION A"). This journey used to assert that flipping the schedule
// dial to "base-hours" HID the Americas-band job from the feed and moved
// `stats.excluded` — that was the 2026-07-14 remote-fit spec §8 behavior,
// which is now stale. tz_band is a RANK signal only: the misaligned job
// stays visible, demoted below the aligned one; relocation/eligibility
// (STAY_TIERS) is the sole remaining hard gate, so `stats.excluded` is
// untouched by this dial.
test("remote-fit: flip schedule dial demotes the misaligned job — both stay visible, excluded count untouched", async ({ page, request }) => {
  const client = createClient({ url: E2E_DB_URL });
  const db = drizzle(client, { schema });

  // Jobs/job_scores are userId-scoped (jobsRepo.listScored filters on
  // jobs.userId) — the e2e session (authSetup.ts) registers its own user,
  // distinct from BOOTSTRAP_ADMIN_ID, so fixture rows must be inserted
  // under that same id or they never appear in this session's /feed.
  const [e2eUser] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, E2E_USER.email));
  if (!e2eUser) throw new Error(`e2e session user not found in DB: ${E2E_USER.email}`);
  const e2eUserId = e2eUser.id;

  // Full-body PUT (Profile requires all 4 fields) — deterministic baseline
  // regardless of what an earlier spec file left behind.
  const baseline = { baseCountry: "MY", relocation: "stay", scheduleFlex: "any-hours", employmentPref: "any" };
  const setProfile = await request.put("/api/profile", { data: baseline });
  if (!setProfile.ok()) throw new Error(`PUT /api/profile failed: ${setProfile.status()} ${await setProfile.text()}`);

  const resumeRes = await request.post("/api/resume", { data: { text: SAMPLE_RESUME } });
  if (!resumeRes.ok()) throw new Error(`POST /api/resume failed: ${resumeRes.status()} ${await resumeRes.text()}`);
  const resume = (await resumeRes.json()) as { id: string };

  const americasJob = await insertJob(db, "greenhouse", {
    dedupeKey: "remote-fit-e2e-americas",
    url: "https://example.com/remote-fit-e2e-americas",
    title: "Platform Reliability Engineer — Americas",
    company: "Remote Fit Americas Co",
    persona: "remote",
    eligibility: "eligible",
    eligibilityEvidence: "test fixture: hires from Malaysia",
    tzBand: "americas",
    userId: e2eUserId,
  });
  await insertJobScore(db, americasJob.id, resume.id, { userId: e2eUserId });

  const apacJob = await insertJob(db, "greenhouse", {
    dedupeKey: "remote-fit-e2e-apac",
    url: "https://example.com/remote-fit-e2e-apac",
    title: "Platform Reliability Engineer — APAC",
    company: "Remote Fit APAC Co",
    persona: "remote",
    eligibility: "eligible",
    eligibilityEvidence: "test fixture: hires from Malaysia",
    tzBand: "apac",
    userId: e2eUserId,
  });
  await insertJobScore(db, apacJob.id, resume.id, { userId: e2eUserId });

  try {
    // Under "any-hours", allowedBandsFor returns null (no gate) — both visible, nothing excluded.
    await page.goto("/feed");
    await expect(page.getByText("Remote Fit Americas Co", { exact: false })).toBeVisible();
    await expect(page.getByText("Remote Fit APAC Co", { exact: false })).toBeVisible();

    const before = await (await request.get("/api/jobs?persona=remote")).json();

    // Flip to "Malaysia hours" (base-hours) — allowedBandsFor admits only
    // `apac` (server/score/tzBand.ts). DECISION A: the Americas job's
    // stated band demotes it in rank, it no longer hides it.
    await page.getByRole("navigation").getByRole("button", { name: "Profile & targets" }).click();
    await expect(page).toHaveURL(/\/profile$/);
    await page.getByRole("button", { name: "Malaysia hours", exact: true }).click();
    await expect(page.getByRole("button", { name: "Malaysia hours", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.getByRole("navigation").getByRole("button", { name: "Matches" }).click();
    await expect(page).toHaveURL(/\/feed$/);
    await expect(page.getByText("Remote Fit APAC Co", { exact: false })).toBeVisible();
    await expect(page.getByText("Remote Fit Americas Co", { exact: false })).toBeVisible();

    // DECISION A: no hard gate left here — relocation/eligibility
    // (STAY_TIERS) is the sole remaining source of `stats.excluded`, so the
    // schedule dial must not move it. Delta not absolute: the shared
    // scratch DB may carry rows from other specs, so 0 is the invariant.
    const after = await (await request.get("/api/jobs?persona=remote")).json();
    expect(after.stats.excluded - before.stats.excluded).toBe(0);
    const afterIds: string[] = after.items.map((j: { id: string }) => j.id);
    expect(afterIds).toContain(americasJob.id); // demoted, not dropped
    expect(afterIds).toContain(apacJob.id);
    expect(afterIds.indexOf(apacJob.id)).toBeLessThan(afterIds.indexOf(americasJob.id)); // aligned ranks above misaligned
  } finally {
    // Restore the seeded default + drop the fixture rows for every other spec (shared scratch DB).
    const restore = await request.put("/api/profile", { data: baseline });
    if (!restore.ok()) throw new Error(`profile restore failed: ${restore.status()} ${await restore.text()}`);
    await db
      .delete(schema.jobScores)
      .where(and(inArray(schema.jobScores.jobId, [americasJob.id, apacJob.id]), eq(schema.jobScores.userId, e2eUserId)));
    await db.delete(schema.jobs).where(and(inArray(schema.jobs.id, [americasJob.id, apacJob.id]), eq(schema.jobs.userId, e2eUserId)));
    client.close();
  }
});
