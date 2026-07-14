import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { E2E_DB_URL } from "./globalSetup";
import { getDb } from "../src/server/persistence/db";
import { jobsRepo } from "../src/server/persistence/repos/jobs";
import { jobScoresRepo } from "../src/server/persistence/repos/jobScores";
import { jobs, jobScores } from "../src/server/persistence/schema";

// Direct-DB seeding seam (see comment below on why this journey can't use a
// scan/paste to produce the fixture) — this must be set before the first
// repo call. Safe: this runs in the Playwright test process, a separate
// Node process from the `next dev` webServer subprocess (playwright.config.ts
// sets its own DATABASE_URL for that one); both simply point at the same
// scratch Postgres (`caliber_e2e`).
process.env.DATABASE_URL = E2E_DB_URL;

// Remote-fit journey (spec 2026-07-14-remote-fit-criteria-design.md §10: "one
// journey — flip the schedule dial on /profile, a US-hours job leaves the
// feed, excluded count moves"). Unlike profile.spec.ts's relocation journey,
// this fact can't be produced by a real scan or paste: e2e's doubles LLM
// (src/lib/llm/scripted-fixtures.ts) is ONE static jd-extract response
// (`tzRequirement: null`) shared by every posting, and none of the fixture
// connector's raw locations ("Remote", "Kuala Lumpur, Malaysia", "New York,
// NY" — src/server/search/connectors/fixture.ts) contain a TZ token
// resolveTzBand's curated table recognizes. So this spec seeds a job
// directly via jobsRepo/jobScoresRepo — the same repo seam
// src/server/persistence/repos/__fixtures__/helpers.ts's insertJob/
// insertJobScore use, and the exact shape jobsFeed.test.ts's "schedule gate"
// describe block already proves end-to-end at the listJobsFeed layer — to
// get a deterministic `tz_band: "americas"` row through the real HTTP+UI
// stack. Cleaned up in `finally` since "remote" persona jobs have no DELETE
// route (deletion is pasted-only, server/jobs/delete-job.ts) and a stray row
// would otherwise outlive this spec in the shared scratch DB.
const SAMPLE_RESUME = "Jane Doe\nSenior Backend Engineer\nPayments, Node.js, Postgres\n" + "x".repeat(120);
const DEDUPE_KEY = "e2e-remote-fit-us-hours";
const JOB_URL = "https://example.com/e2e-remote-fit-us-hours";
const COMPANY = "Meridian Analytics";

test("remote-fit: schedule dial re-scopes the feed, hiding a US-hours job with zero rescan", async ({
  page,
  request,
}) => {
  const resumeRes = await request.post("/api/resume", { data: { text: SAMPLE_RESUME } });
  if (!resumeRes.ok()) throw new Error(`POST /api/resume failed: ${resumeRes.status()} ${await resumeRes.text()}`);
  const resume = (await resumeRes.json()) as { id: string };

  // Otherwise fully eligible: "anywhere" tier (never geo-hidden under either
  // relocation setting) and no hiringStructure (never structure-hidden) — so
  // only the schedule gate is ever in play for this row.
  const job = await jobsRepo.upsertByDedupeKey({
    dedupeKey: DEDUPE_KEY,
    url: JOB_URL,
    sourceId: "greenhouse",
    title: "Senior Backend Engineer, Payments",
    company: COMPANY,
    location: "Remote (US hours)",
    persona: "remote",
    eligibility: "anywhere",
    eligibilityEvidence: "e2e fixture: seeded anywhere",
    tzBand: "americas",
    hiringStructure: null,
    aliases: [],
    raw: {},
  });
  await jobScoresRepo.upsertByJobResumePolicy({
    jobId: job.id,
    resumeId: resume.id,
    score: 4.2,
    verdict: "Apply",
    why: "Strong overlap with recent backend/payments experience.",
    legitimacy: { tier: "clear", tone: "good", summary: "Looks like a normal listing.", signals: [] },
    liveness: "active",
    breakdown: [],
    reasons: { for: [], against: [] },
    fit: [],
    gaps: [],
    jdFacts: {},
    model: "test-model",
    escalated: false,
    costUsd: 0.01,
    policyVersion: "e2e-fixture",
  });

  try {
    // Default seeded dials (seed-test.ts: scheduleFlex "any-hours") admit
    // every band — the US-hours job is visible. The "US hours" schedule pill
    // (assembleJob's `job.tags` extraTags, spec §7) renders on both the
    // job-detail page (JobDetail.tsx maps `job.tags`) and the feed row
    // (JobRow.tsx renders `job.tags.slice(1)` beside the Legitimacy/Eligibility
    // tags — index 0 is the legitimacy tag, already shown separately).
    await page.goto("/feed");
    await expect(page.getByText(COMPANY, { exact: false }).first()).toBeVisible();

    const before = await (await request.get("/api/jobs?persona=remote")).json();
    expect(before.items.some((j: { company: string }) => j.company === COMPANY)).toBe(true);

    // Flip the schedule dial to "Malaysia hours" (base-hours) — hiddenBandsFor
    // ("base-hours") includes "americas" (tzBand.ts BAND_MIN).
    await page.getByRole("navigation").getByRole("button", { name: "Profile & targets" }).click();
    await expect(page).toHaveURL(/\/profile$/);
    const baseHours = page.getByRole("button", { name: "Malaysia hours" });
    await expect(baseHours).toHaveAttribute("aria-pressed", "false");
    await baseHours.click();
    await expect(baseHours).toHaveAttribute("aria-pressed", "true");

    // Return to the feed via the sidebar — same rows, instantly re-scoped.
    // No "Scan now" click anywhere in this spec: the re-scope is proven with
    // zero rescan.
    await page.getByRole("navigation").getByRole("button", { name: "Matches" }).click();
    await expect(page).toHaveURL(/\/feed$/);
    await expect(page.getByText(COMPANY, { exact: false })).not.toBeVisible();

    const after = await (await request.get("/api/jobs?persona=remote")).json();
    expect(after.items.some((j: { company: string }) => j.company === COMPANY)).toBe(false);
    expect(after.stats.excluded).toBe(before.stats.excluded + 1);
  } finally {
    // Restore the seeded default profile for every other spec (shared
    // scratch DB), then remove the seeded job/score directly — see the
    // header comment on why the DELETE route can't do this one.
    const restore = await request.put("/api/profile", {
      data: { baseCountry: "MY", relocation: "stay", scheduleFlex: "any-hours", employmentPref: "any" },
    });
    if (!restore.ok()) throw new Error(`profile restore failed: ${restore.status()} ${await restore.text()}`);

    const db = getDb();
    await db.delete(jobScores).where(eq(jobScores.jobId, job.id));
    await db.delete(jobs).where(eq(jobs.id, job.id));
  }
});
