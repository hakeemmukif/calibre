import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { insertJob, insertJobScore, insertProfile, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { jobs, jobScores, resumes, sources } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import type { JdFacts } from "./jdFacts";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { recomputeEligibility } = await import("./recompute-eligibility");

// Minimal valid JdFacts — every required field present, remote-fit fields
// added per test case (mirrors scoreJob.test.ts's `jdFacts` fixture).
const baseJdFacts: JdFacts = {
  title: "Backend Engineer",
  mustHaves: [],
  niceToHaves: [],
  responsibilities: [],
  redFlags: [],
};

describe("recomputeEligibility", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
    await insertProfile(state.testDb); // singleton — afterEach never wipes it
  });

  afterEach(async () => {
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(sources);
    await state.testDb.delete(resumes);
  });

  it("jdFacts.tzRequirement 'PST' -> recompute writes tz_band 'americas'", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb);
    await insertJobScore(state.testDb, job.id, resume.id, {
      jdFacts: { ...baseJdFacts, tzRequirement: "PST" },
    });
    expect(job.tzBand).toBeNull();

    const result = await recomputeEligibility();

    const [after] = await state.testDb.select().from(jobs).where(eq(jobs.id, job.id));
    expect(after.tzBand).toBe("americas");
    expect(result.tzChanged).toBe(1);
  });

  it("a SAFE token misfiled in hiringCountries (e.g. ['APAC'], no tzRequirement) is scavenged -> tz_band 'apac'", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb);
    await insertJobScore(state.testDb, job.id, resume.id, {
      jdFacts: { ...baseJdFacts, hiringCountries: ["APAC"] },
    });

    const result = await recomputeEligibility();

    const [after] = await state.testDb.select().from(jobs).where(eq(jobs.id, job.id));
    expect(after.tzBand).toBe("apac");
    expect(result.tzChanged).toBe(1);
  });

  // RED-proof for Fix 1: hiringCountries is a COUNTRY list, not a stated TZ
  // requirement. A bare "PT" there means Portugal (ISO code), not a stated
  // Pacific-Time requirement. Against the old `probeTzToken(c, "stated")`
  // code, STATED_ONLY_TOKENS (/\b(ET|PT)\b/) would match "PT" and this test
  // would see tz_band === "americas" — the §14.2 trust-killer inversion.
  // Under the fixed `probeTzToken(c, "location")` call, STATED_ONLY_TOKENS
  // never fire for a hiringCountries entry, so tz_band stays null.
  it("a bare 'PT' in hiringCountries (no tzRequirement) does NOT map -- tz_band stays null (trust-killer guard)", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb);
    await insertJobScore(state.testDb, job.id, resume.id, {
      jdFacts: { ...baseJdFacts, hiringCountries: ["PT"] },
    });

    const result = await recomputeEligibility();

    const [after] = await state.testDb.select().from(jobs).where(eq(jobs.id, job.id));
    expect(after.tzBand).toBeNull();
    expect(result.tzChanged).toBe(0);
  });

  it("write-on-change only: updates a job whose derived band differs (incl. write-back to null), leaves an already-correct null band untouched", async () => {
    const source = await insertSource(state.testDb);
    const resume = await insertResume(state.testDb);

    const jobA = await insertJob(state.testDb, source.id, { tzBand: "emea" });
    await insertJobScore(state.testDb, jobA.id, resume.id, {
      jdFacts: { ...baseJdFacts, tzRequirement: "PST" },
    });

    const jobB = await insertJob(state.testDb, source.id, { tzBand: "apac" });
    await insertJobScore(state.testDb, jobB.id, resume.id, {
      jdFacts: { ...baseJdFacts, hiringCountries: ["Malaysia"] },
    });

    const jobC = await insertJob(state.testDb, source.id);
    await insertJobScore(state.testDb, jobC.id, resume.id, { jdFacts: baseJdFacts });

    const result = await recomputeEligibility();
    expect(result.tzChanged).toBe(2); // A (emea->americas) + B (apac->null); C (null->null) untouched

    const [afterA] = await state.testDb.select().from(jobs).where(eq(jobs.id, jobA.id));
    const [afterB] = await state.testDb.select().from(jobs).where(eq(jobs.id, jobB.id));
    const [afterC] = await state.testDb.select().from(jobs).where(eq(jobs.id, jobC.id));
    expect(afterA.tzBand).toBe("americas");
    expect(afterB.tzBand).toBeNull(); // non-null stored -> null derived: write-back exercised
    expect(afterC.tzBand).toBeNull(); // unchanged, not counted
  });
});
