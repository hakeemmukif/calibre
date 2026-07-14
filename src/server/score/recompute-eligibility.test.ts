// Recompute extension (Task 9, spec 2026-07-14 §6/§11): re-derives
// jobs.tzBand/hiringStructure from the latest job_scores.jd_facts alongside
// the existing eligibility recompute — zero LLM cost, migrates legacy rows
// whose TZ terms landed in jd_facts.hiringCountries before the Task-2 template fix.
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { insertJob, insertJobScore, insertProfile, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { jobs, jobScores, resumes, sources } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import type { JdFacts } from "./jdFacts";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { recomputeEligibility } = await import("./recompute-eligibility");

const bareFacts: Pick<JdFacts, "title" | "mustHaves" | "niceToHaves" | "responsibilities" | "redFlags"> = {
  title: "Role",
  mustHaves: [],
  niceToHaves: [],
  responsibilities: [],
  redFlags: [],
};

describe("recomputeEligibility — tz_band/hiring_structure re-derivation (Task 9)", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
    await insertProfile(state.testDb);
  });

  afterEach(async () => {
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(sources);
    await state.testDb.delete(resumes);
  });

  it("stamps tz_band + hiring_structure from stated jd_facts on a job with NULL columns", async () => {
    const source = await insertSource(state.testDb);
    const resume = await insertResume(state.testDb);
    const job = await insertJob(state.testDb, source.id, { location: "Remote" });
    const statedFacts: JdFacts = { ...bareFacts, tzRequirement: "EU hours", hiringStructure: "contractor" };
    await insertJobScore(state.testDb, job.id, resume.id, { jdFacts: statedFacts });

    const { changed } = await recomputeEligibility();

    const [after] = await state.testDb.select().from(jobs).where(eq(jobs.id, job.id));
    expect(after.tzBand).toBe("emea");
    expect(after.hiringStructure).toBe("contractor");
    expect(changed).toBeGreaterThanOrEqual(1);
  });

  it("migrates a legacy row: TZ term stated in jd_facts.hiringCountries (pre-fix) maps to a band", async () => {
    const source = await insertSource(state.testDb);
    const resume = await insertResume(state.testDb);
    const job = await insertJob(state.testDb, source.id, { location: "Remote" });
    const legacyFacts: JdFacts = { ...bareFacts, hiringCountries: ["4h overlap with PST"] };
    await insertJobScore(state.testDb, job.id, resume.id, { jdFacts: legacyFacts });

    const { changed } = await recomputeEligibility();

    const [after] = await state.testDb.select().from(jobs).where(eq(jobs.id, job.id));
    expect(after.tzBand).toBe("americas");
    expect(changed).toBeGreaterThanOrEqual(1);
  });

  it("returns { total, changed } counting only rows that actually differ", async () => {
    const source = await insertSource(state.testDb);
    const resume = await insertResume(state.testDb);
    const job = await insertJob(state.testDb, source.id, { location: "Remote", eligibility: "unknown", eligibilityEvidence: 'bare "Remote" — employer hiring scope unproven' });
    await insertJobScore(state.testDb, job.id, resume.id, { jdFacts: bareFacts });

    const first = await recomputeEligibility();
    expect(first.total).toBe(1);
    expect(first.changed).toBe(0); // nothing stated, columns already NULL/matching — no drift

    const second = await recomputeEligibility();
    expect(second.changed).toBe(0); // idempotent — re-running with no changes touches nothing
  });
});
