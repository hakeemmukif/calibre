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

    // Flip back to "Any hours" (any-hours admits every band, tzBand.ts
    // BAND_MIN) — the job reappears and excluded returns to baseline, with
    // zero rescan either direction.
    await page.getByRole("navigation").getByRole("button", { name: "Profile & targets" }).click();
    await expect(page).toHaveURL(/\/profile$/);
    const anyHours = page.getByRole("button", { name: "Any hours — US overlap" });
    await expect(anyHours).toHaveAttribute("aria-pressed", "false");
    await anyHours.click();
    await expect(anyHours).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("navigation").getByRole("button", { name: "Matches" }).click();
    await expect(page).toHaveURL(/\/feed$/);
    await expect(page.getByText(COMPANY, { exact: false }).first()).toBeVisible();

    const restored = await (await request.get("/api/jobs?persona=remote")).json();
    expect(restored.items.some((j: { company: string }) => j.company === COMPANY)).toBe(true);
    expect(restored.stats.excluded).toBe(before.stats.excluded);
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

// Profile & targets journey for the schedule/employment dials (spec §8):
// the "Global remote" preset sets all three dials at once and saves; the
// schedule/employment segmented controls also save individually on click;
// every save round-trips PUT /api/profile onto the singleton row, so a full
// reload (no client cache) must still reflect it.
test("remote-fit: 'Global remote' preset + individual schedule/employment dials persist across reload", async ({
  page,
  request,
}) => {
  try {
    await page.goto("/profile");
    await expect(page.locator("header").getByText("Profile & targets")).toBeVisible();

    const relocationStay = page.getByRole("button", { name: "Stay in Malaysia", exact: true });
    const scheduleEvenings = page.getByRole("button", { name: "Evenings OK — Europe overlap" });
    const scheduleBase = page.getByRole("button", { name: "Malaysia hours" });
    const employmentAny = page.getByRole("button", { name: "Any arrangement" });
    const employmentLocal = page.getByRole("button", { name: "Malaysian entity only" });

    // Seeded default: any-hours / any.
    await expect(page.getByRole("button", { name: "Any hours — US overlap" })).toHaveAttribute("aria-pressed", "true");
    await expect(employmentAny).toHaveAttribute("aria-pressed", "true");

    // "Global remote" preset (ProfileTargets.tsx PRESETS.global): relocation
    // stay / scheduleFlex flex-evenings / employmentPref any, all in one save.
    await page.getByRole("button", { name: "Preset: Global remote" }).click();
    await expect(relocationStay).toHaveAttribute("aria-pressed", "true");
    await expect(scheduleEvenings).toHaveAttribute("aria-pressed", "true");
    await expect(employmentAny).toHaveAttribute("aria-pressed", "true");

    await page.reload();
    await expect(relocationStay).toHaveAttribute("aria-pressed", "true");
    await expect(scheduleEvenings).toHaveAttribute("aria-pressed", "true");
    await expect(employmentAny).toHaveAttribute("aria-pressed", "true");

    // The schedule control saves independently of the preset.
    await scheduleBase.click();
    await expect(scheduleBase).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await expect(scheduleBase).toHaveAttribute("aria-pressed", "true");
    await expect(employmentAny).toHaveAttribute("aria-pressed", "true"); // untouched by the schedule save

    // The employment control saves independently too.
    await employmentLocal.click();
    await expect(employmentLocal).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await expect(employmentLocal).toHaveAttribute("aria-pressed", "true");
    await expect(scheduleBase).toHaveAttribute("aria-pressed", "true"); // untouched by the employment save
  } finally {
    const restore = await request.put("/api/profile", {
      data: { baseCountry: "MY", relocation: "stay", scheduleFlex: "any-hours", employmentPref: "any" },
    });
    if (!restore.ok()) throw new Error(`profile restore failed: ${restore.status()} ${await restore.text()}`);
  }
});

// Baseline permissive no-op (spec §7 regression) + row/detail pills (spec
// §7 display): under the seeded default dials (any-hours/any) a stated
// americas+contractor job is never hidden, and both feed row and detail
// page show its "US hours"/"Contractor" pills plus the workCalendar gap.
// An apac-band sibling proves the schedule pill is suppressed for apac
// (business-as-usual from base country MY, assemble.ts SCHEDULE_LABEL).
test("remote-fit: permissive dials show schedule/structure pills on the row and detail page; apac suppresses the schedule pill", async ({
  page,
  request,
}) => {
  const resumeRes = await request.post("/api/resume", { data: { text: SAMPLE_RESUME } });
  if (!resumeRes.ok()) throw new Error(`POST /api/resume failed: ${resumeRes.status()} ${await resumeRes.text()}`);
  const resume = (await resumeRes.json()) as { id: string };

  const PILL_COMPANY = "Borealis Systems";
  const WORK_CALENDAR = "Core hours 9am-1pm US Eastern, async otherwise";
  const pillJob = await jobsRepo.upsertByDedupeKey({
    dedupeKey: "e2e-remote-fit-permissive-pills",
    url: "https://example.com/e2e-remote-fit-permissive-pills",
    sourceId: "greenhouse",
    title: "Staff Platform Engineer",
    company: PILL_COMPANY,
    location: "Remote (contract)",
    persona: "remote",
    eligibility: "anywhere",
    eligibilityEvidence: "e2e fixture: seeded anywhere",
    tzBand: "americas",
    hiringStructure: "contractor",
    aliases: [],
    raw: {},
  });
  await jobScoresRepo.upsertByJobResumePolicy({
    jobId: pillJob.id,
    resumeId: resume.id,
    score: 4.0,
    verdict: "Apply",
    why: "Strong platform engineering overlap.",
    legitimacy: { tier: "clear", tone: "good", summary: "Looks like a normal listing.", signals: [] },
    liveness: "active",
    breakdown: [],
    reasons: { for: [], against: [] },
    fit: [],
    gaps: [],
    jdFacts: { workCalendar: WORK_CALENDAR },
    model: "test-model",
    escalated: false,
    costUsd: 0.01,
    policyVersion: "e2e-fixture",
  });

  const APAC_COMPANY = "Halcyon Robotics";
  const apacJob = await jobsRepo.upsertByDedupeKey({
    dedupeKey: "e2e-remote-fit-apac-suppress",
    url: "https://example.com/e2e-remote-fit-apac-suppress",
    sourceId: "ashby",
    title: "APAC Support Engineer",
    company: APAC_COMPANY,
    location: "Remote (APAC hours)",
    persona: "remote",
    eligibility: "anywhere",
    eligibilityEvidence: "e2e fixture: seeded anywhere",
    tzBand: "apac",
    hiringStructure: null,
    aliases: [],
    raw: {},
  });
  await jobScoresRepo.upsertByJobResumePolicy({
    jobId: apacJob.id,
    resumeId: resume.id,
    score: 3.8,
    verdict: "Consider",
    why: "Reasonable overlap for a support role.",
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
    await page.goto("/feed");

    // Row-level: JobRow.tsx renders `job.tags.slice(1)` — the schedule pill
    // ("US hours") and structure pill ("Contractor") sit beside the
    // Legitimacy/Eligibility tags. `[role="button"]` scopes to that job's
    // Card only (JobRow's outer Card is the only element in the row with an
    // explicit role="button" — the nested Open/Save/Dismiss IconButtons are
    // plain <button>s with no explicit role attribute).
    const pillRow = page.locator('[role="button"]').filter({ hasText: PILL_COMPANY });
    await expect(pillRow).toBeVisible();
    await expect(pillRow.getByText("US hours")).toBeVisible();
    await expect(pillRow.getByText("Contractor")).toBeVisible();

    const apacRow = page.locator('[role="button"]').filter({ hasText: APAC_COMPANY });
    await expect(apacRow).toBeVisible();
    await expect(apacRow.getByText("US hours")).toHaveCount(0);
    await expect(apacRow.getByText("EU hours")).toHaveCount(0);

    // Detail page: JobDetail.tsx renders the full `job.tags` (no slice) plus
    // the workCalendar gap row (assemble.ts appends it to `job.gaps`).
    await pillRow.click();
    await expect(page).toHaveURL(new RegExp(`/jobs/${pillJob.id}$`));
    await expect(page.getByText("US hours")).toBeVisible();
    await expect(page.getByText("Contractor")).toBeVisible();
    await expect(page.getByText("Work calendar")).toBeVisible();
    await expect(page.getByText(WORK_CALENDAR)).toBeVisible();

    // apac's detail page carries no schedule pill either.
    await page.goto("/feed");
    await page.locator('[role="button"]').filter({ hasText: APAC_COMPANY }).click();
    await expect(page).toHaveURL(new RegExp(`/jobs/${apacJob.id}$`));
    await expect(page.getByText("US hours")).toHaveCount(0);
    await expect(page.getByText("EU hours")).toHaveCount(0);
  } finally {
    const db = getDb();
    await db.delete(jobScores).where(eq(jobScores.jobId, pillJob.id));
    await db.delete(jobs).where(eq(jobs.id, pillJob.id));
    await db.delete(jobScores).where(eq(jobScores.jobId, apacJob.id));
    await db.delete(jobs).where(eq(jobs.id, apacJob.id));
  }
});

// Structure gate (spec §7): employmentPref "employee" hides only
// "contractor" (hiddenStructuresFor) — an "eor" sibling stays visible.
test("remote-fit: employment dial hides a contractor job while an eor sibling stays visible", async ({
  page,
  request,
}) => {
  const resumeRes = await request.post("/api/resume", { data: { text: SAMPLE_RESUME } });
  if (!resumeRes.ok()) throw new Error(`POST /api/resume failed: ${resumeRes.status()} ${await resumeRes.text()}`);
  const resume = (await resumeRes.json()) as { id: string };

  const CONTRACTOR_COMPANY = "Vantage Contracting";
  const contractorJob = await jobsRepo.upsertByDedupeKey({
    dedupeKey: "e2e-remote-fit-structure-contractor",
    url: "https://example.com/e2e-remote-fit-structure-contractor",
    sourceId: "lever",
    title: "Contract Backend Engineer",
    company: CONTRACTOR_COMPANY,
    location: "Remote (contract)",
    persona: "remote",
    eligibility: "anywhere",
    eligibilityEvidence: "e2e fixture: seeded anywhere",
    tzBand: null,
    hiringStructure: "contractor",
    aliases: [],
    raw: {},
  });
  await jobScoresRepo.upsertByJobResumePolicy({
    jobId: contractorJob.id,
    resumeId: resume.id,
    score: 4.1,
    verdict: "Apply",
    why: "Strong backend overlap.",
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

  const EOR_COMPANY = "Northwind EOR Co";
  const eorJob = await jobsRepo.upsertByDedupeKey({
    dedupeKey: "e2e-remote-fit-structure-eor-sibling",
    url: "https://example.com/e2e-remote-fit-structure-eor-sibling",
    sourceId: "ashby",
    title: "EOR Backend Engineer",
    company: EOR_COMPANY,
    location: "Remote (EOR)",
    persona: "remote",
    eligibility: "anywhere",
    eligibilityEvidence: "e2e fixture: seeded anywhere",
    tzBand: null,
    hiringStructure: "eor",
    aliases: [],
    raw: {},
  });
  await jobScoresRepo.upsertByJobResumePolicy({
    jobId: eorJob.id,
    resumeId: resume.id,
    score: 4.0,
    verdict: "Apply",
    why: "Strong backend overlap.",
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
    await page.goto("/feed");
    await expect(page.getByText(CONTRACTOR_COMPANY, { exact: false }).first()).toBeVisible();
    await expect(page.getByText(EOR_COMPANY, { exact: false }).first()).toBeVisible();

    const before = await (await request.get("/api/jobs?persona=remote")).json();
    expect(before.items.some((j: { company: string }) => j.company === CONTRACTOR_COMPANY)).toBe(true);

    await page.getByRole("navigation").getByRole("button", { name: "Profile & targets" }).click();
    await expect(page).toHaveURL(/\/profile$/);
    const employeeOpt = page.getByRole("button", { name: "Employee — EOR OK" });
    await expect(employeeOpt).toHaveAttribute("aria-pressed", "false");
    await employeeOpt.click();
    await expect(employeeOpt).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("navigation").getByRole("button", { name: "Matches" }).click();
    await expect(page).toHaveURL(/\/feed$/);
    await expect(page.getByText(CONTRACTOR_COMPANY, { exact: false })).not.toBeVisible();
    await expect(page.getByText(EOR_COMPANY, { exact: false }).first()).toBeVisible();

    const after = await (await request.get("/api/jobs?persona=remote")).json();
    expect(after.items.some((j: { company: string }) => j.company === CONTRACTOR_COMPANY)).toBe(false);
    expect(after.items.some((j: { company: string }) => j.company === EOR_COMPANY)).toBe(true);
    expect(after.stats.excluded).toBe(before.stats.excluded + 1);
  } finally {
    const restore = await request.put("/api/profile", {
      data: { baseCountry: "MY", relocation: "stay", scheduleFlex: "any-hours", employmentPref: "any" },
    });
    if (!restore.ok()) throw new Error(`profile restore failed: ${restore.status()} ${await restore.text()}`);

    const db = getDb();
    await db.delete(jobScores).where(eq(jobScores.jobId, contractorJob.id));
    await db.delete(jobs).where(eq(jobs.id, contractorJob.id));
    await db.delete(jobScores).where(eq(jobScores.jobId, eorJob.id));
    await db.delete(jobs).where(eq(jobs.id, eorJob.id));
  }
});

// NULL passes + pasted exemption (spec §7, §2.12): a job with no stated
// band/structure is never hidden even under the strictest dials
// (base-hours + local-entity), and a pasted-persona job keeps its
// otherwise-hidden americas/contractor facts visible in the Pasted scope
// because listJobsFeed drops both gates for `persona === "pasted"`.
test("remote-fit: NULL band/structure always passes; a pasted job is exempt from the schedule/structure dials", async ({
  page,
  request,
}) => {
  const resumeRes = await request.post("/api/resume", { data: { text: SAMPLE_RESUME } });
  if (!resumeRes.ok()) throw new Error(`POST /api/resume failed: ${resumeRes.status()} ${await resumeRes.text()}`);
  const resume = (await resumeRes.json()) as { id: string };

  const NULL_COMPANY = "Quietwave Labs";
  const nullJob = await jobsRepo.upsertByDedupeKey({
    dedupeKey: "e2e-remote-fit-null-passthrough",
    url: "https://example.com/e2e-remote-fit-null-passthrough",
    sourceId: "greenhouse",
    title: "Generalist Software Engineer",
    company: NULL_COMPANY,
    location: "Remote",
    persona: "remote",
    eligibility: "anywhere",
    eligibilityEvidence: "e2e fixture: seeded anywhere",
    tzBand: null,
    hiringStructure: null,
    aliases: [],
    raw: {},
  });
  await jobScoresRepo.upsertByJobResumePolicy({
    jobId: nullJob.id,
    resumeId: resume.id,
    score: 3.9,
    verdict: "Apply",
    why: "Broad generalist overlap.",
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

  const PASTED_COMPANY = "Driftline Ventures";
  const pastedJob = await jobsRepo.upsertByDedupeKey({
    dedupeKey: "e2e-remote-fit-pasted-exempt",
    url: "https://example.com/e2e-remote-fit-pasted-exempt",
    sourceId: "manual", // pasted jobs always attach to the "manual" source (server/url-check/run.ts)
    title: "Pasted Contract Role, US Hours",
    company: PASTED_COMPANY,
    location: "Remote (US hours, contract)",
    persona: "pasted",
    eligibility: "anywhere",
    eligibilityEvidence: "e2e fixture: seeded anywhere",
    tzBand: "americas",
    hiringStructure: "contractor",
    aliases: [],
    raw: {},
  });
  await jobScoresRepo.upsertByJobResumePolicy({
    jobId: pastedJob.id,
    resumeId: resume.id,
    score: 4.0,
    verdict: "Apply",
    why: "Strong overlap, pasted directly.",
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
    // Strictest dials: base-hours admits only apac; local-entity admits only
    // local-entity structure (hiddenStructuresFor -> ["eor", "contractor"]).
    const strict = await request.put("/api/profile", {
      data: { baseCountry: "MY", relocation: "stay", scheduleFlex: "base-hours", employmentPref: "local-entity" },
    });
    if (!strict.ok()) throw new Error(`profile strict-dial setup failed: ${strict.status()} ${await strict.text()}`);

    await page.goto("/feed");
    await expect(page.getByText(NULL_COMPANY, { exact: false }).first()).toBeVisible();

    // Switch to the Pasted scope — schedule/structure dials are dropped there.
    await page.getByRole("button", { name: "Pasted", exact: true }).click();
    await expect(page.getByText(PASTED_COMPANY, { exact: false }).first()).toBeVisible();

    const pastedFeed = await (await request.get("/api/jobs?persona=pasted")).json();
    expect(pastedFeed.items.some((j: { company: string }) => j.company === PASTED_COMPANY)).toBe(true);
    expect(pastedFeed.stats.excluded).toBe(0); // Pasted scope never counts anything as excluded

    const remoteFeed = await (await request.get("/api/jobs?persona=remote")).json();
    expect(remoteFeed.items.some((j: { company: string }) => j.company === NULL_COMPANY)).toBe(true);
  } finally {
    const restore = await request.put("/api/profile", {
      data: { baseCountry: "MY", relocation: "stay", scheduleFlex: "any-hours", employmentPref: "any" },
    });
    if (!restore.ok()) throw new Error(`profile restore failed: ${restore.status()} ${await restore.text()}`);

    const db = getDb();
    await db.delete(jobScores).where(eq(jobScores.jobId, nullJob.id));
    await db.delete(jobs).where(eq(jobs.id, nullJob.id));
    await db.delete(jobScores).where(eq(jobScores.jobId, pastedJob.id));
    await db.delete(jobs).where(eq(jobs.id, pastedJob.id));
  }
});
