import { expect, test } from "@playwright/test";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { insertJob, insertJobScore } from "../src/server/persistence/repos/__fixtures__/helpers";
import * as schema from "../src/server/persistence/schema";
import { E2E_DB_URL } from "./globalSetup";

// Remote-fit dial-flip journey (spec 2026-07-14-remote-fit-criteria-design.md
// §7/§8/§11), the tz_band sibling of profile.spec.ts's relocation-flip
// journey: flipping the schedule dial re-scopes the feed with zero rescan.
// Jobs are seeded directly with a job_scores row (not via the scan-doubles
// fixtures, which carry no tz_band control) — every feed/detail query
// inner-joins job_scores, so an unscored job never appears (jobsRepo.listScored).
const SAMPLE_RESUME = "Jane Doe\nSenior Backend Engineer\nPayments, Node.js, Postgres\n" + "x".repeat(120);

test("remote-fit: flip schedule dial re-scopes the feed and the excluded count moves", async ({ page, request }) => {
  const client = postgres(E2E_DB_URL);
  const db = drizzle(client, { schema });

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
  });
  await insertJobScore(db, americasJob.id, resume.id);

  const apacJob = await insertJob(db, "greenhouse", {
    dedupeKey: "remote-fit-e2e-apac",
    url: "https://example.com/remote-fit-e2e-apac",
    title: "Platform Reliability Engineer — APAC",
    company: "Remote Fit APAC Co",
    persona: "remote",
    eligibility: "eligible",
    eligibilityEvidence: "test fixture: hires from Malaysia",
    tzBand: "apac",
  });
  await insertJobScore(db, apacJob.id, resume.id);

  try {
    // Under "any-hours", allowedBandsFor returns null (no gate) — both visible, nothing excluded.
    await page.goto("/feed");
    await expect(page.getByText("Remote Fit Americas Co", { exact: false })).toBeVisible();
    await expect(page.getByText("Remote Fit APAC Co", { exact: false })).toBeVisible();

    const before = await (await request.get("/api/jobs?persona=remote")).json();
    expect(before.stats.excluded).toBe(0);

    // Flip to "Malaysia hours" (base-hours) — allowedBandsFor admits only
    // `apac` (server/score/tzBand.ts), so the Americas job's stated band is
    // now hidden by the schedule gate.
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
    await expect(page.getByText("Remote Fit Americas Co", { exact: false })).not.toBeVisible();

    // The trust signal (spec §8) — not just the row vanishing, the Excluded
    // count moving to account for it.
    const after = await (await request.get("/api/jobs?persona=remote")).json();
    expect(after.stats.excluded).toBe(1);
    expect(after.items.some((j: { company: string }) => j.company === "Remote Fit Americas Co")).toBe(false);
    expect(after.items.some((j: { company: string }) => j.company === "Remote Fit APAC Co")).toBe(true);
  } finally {
    // Restore the seeded default + drop the fixture rows for every other spec (shared scratch DB).
    const restore = await request.put("/api/profile", { data: baseline });
    if (!restore.ok()) throw new Error(`profile restore failed: ${restore.status()} ${await restore.text()}`);
    await db.delete(schema.jobScores).where(inArray(schema.jobScores.jobId, [americasJob.id, apacJob.id]));
    await db.delete(schema.jobs).where(inArray(schema.jobs.id, [americasJob.id, apacJob.id]));
    await client.end();
  }
});
