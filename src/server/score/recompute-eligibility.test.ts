import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";
import { insertJob, insertJobScore, insertProfile, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { jobs, users } from "@/server/persistence/schema";
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

// Layer C (JD-stated hiring scope) beats source/location, so a fixed "ats"
// source with no geo prior is enough to isolate the per-owner profile as
// the only variable that decides the tier.
async function seedOwner(db: TestDb, opts: { userId: string; baseCountry: string; sourceId: string }) {
  const job = await insertJob(db, opts.sourceId, {
    userId: opts.userId,
    eligibility: "unknown",
    eligibilityEvidence: "test fixture",
  });
  const resume = await insertResume(db, { userId: opts.userId, isActive: false });
  return { job, resume };
}

describe("recomputeEligibility", () => {
  let source: Awaited<ReturnType<typeof insertSource>>;

  beforeEach(async () => {
    // A fresh libsql test DB per test (createTestDb re-applies migrations),
    // so there's no cross-test state to tear down.
    state.testDb = await createTestDb();
    source = await insertSource(state.testDb, { kind: "ats", config: { geo: { scope: "restricted" } } });
  });

  it("jdFacts.tzRequirement 'PST' -> recompute writes tz_band 'americas'", async () => {
    await insertProfile(state.testDb);
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
    await insertProfile(state.testDb);
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
    await insertProfile(state.testDb);
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
    await insertProfile(state.testDb);
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

  it("resolves each job against ITS OWNER's profile, not one global profile", async () => {
    // Owner A: bootstrap admin, based in Malaysia.
    await insertProfile(state.testDb, { userId: BOOTSTRAP_ADMIN_ID, baseCountry: "MY", relocation: "stay" });
    const { job: jobA, resume: resumeA } = await seedOwner(state.testDb, {
      userId: BOOTSTRAP_ADMIN_ID,
      baseCountry: "MY",
      sourceId: source.id,
    });
    await insertJobScore(state.testDb, jobA.id, resumeA.id, {
      userId: BOOTSTRAP_ADMIN_ID,
      jdFacts: { hiringScope: "restricted", hiringCountries: ["Malaysia"] },
    });

    // Owner B: separate user, based in the US — a DIFFERENT profile whose
    // baseCountry decides a DIFFERENT tier for the same-shaped JD facts.
    const [userB] = await state.testDb
      .insert(users)
      .values({ email: "user-b-recompute@example.com", passwordHash: "h", role: "user" })
      .returning();
    await insertProfile(state.testDb, { id: "profile-b", userId: userB.id, baseCountry: "US", relocation: "open" });
    const { job: jobB, resume: resumeB } = await seedOwner(state.testDb, {
      userId: userB.id,
      baseCountry: "US",
      sourceId: source.id,
    });
    await insertJobScore(state.testDb, jobB.id, resumeB.id, {
      userId: userB.id,
      jdFacts: { hiringScope: "restricted", hiringCountries: ["United States"] },
    });

    // Owner C: a third user who has NOT onboarded yet (no profile row).
    const [userC] = await state.testDb
      .insert(users)
      .values({ email: "user-c-recompute@example.com", passwordHash: "h", role: "user" })
      .returning();
    const { job: jobC, resume: resumeC } = await seedOwner(state.testDb, {
      userId: userC.id,
      baseCountry: "n/a",
      sourceId: source.id,
    });
    await insertJobScore(state.testDb, jobC.id, resumeC.id, {
      userId: userC.id,
      jdFacts: { hiringScope: "restricted", hiringCountries: ["Malaysia"] },
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await recomputeEligibility();
    warnSpy.mockRestore();

    // Neither A's nor B's jdFacts carry a tz token ("Malaysia"/"United
    // States" match no SAFE_TOKENS pattern) and both jobs' `location` is the
    // fixture default "Remote" — tzChanged stays 0 here.
    expect(result).toEqual({ total: 3, changed: 2, skipped: 1, tzChanged: 0 });

    const [refreshedA] = await state.testDb.select().from(jobs).where(eq(jobs.id, jobA.id));
    const [refreshedB] = await state.testDb.select().from(jobs).where(eq(jobs.id, jobB.id));
    const [refreshedC] = await state.testDb.select().from(jobs).where(eq(jobs.id, jobC.id));

    // A's job, resolved against A's MY profile: "Malaysia" matches -> eligible.
    expect(refreshedA.eligibility).toBe("eligible");
    expect(refreshedA.eligibilityEvidence).toBe("JD: hires in Malaysia");

    // B's job, resolved against B's US profile: "United States" matches ->
    // eligible. If this had cross-contaminated against A's (or the admin's)
    // MY profile, "United States" would NOT match Malaysia and this would
    // come back "abroad" instead — the assertion below catches that bug.
    expect(refreshedB.eligibility).toBe("eligible");
    expect(refreshedB.eligibilityEvidence).toBe("JD: hires in United States");

    // C's job: owner has no profile -> skipped, left exactly as seeded.
    expect(refreshedC.eligibility).toBe("unknown");
    expect(refreshedC.eligibilityEvidence).toBe("test fixture");
  });

  it("caches profiles per owner instead of refetching per job", async () => {
    await insertProfile(state.testDb, { userId: BOOTSTRAP_ADMIN_ID, baseCountry: "MY", relocation: "stay" });
    const { job: jobA1, resume: resumeA1 } = await seedOwner(state.testDb, {
      userId: BOOTSTRAP_ADMIN_ID,
      baseCountry: "MY",
      sourceId: source.id,
    });
    const { job: jobA2 } = await seedOwner(state.testDb, {
      userId: BOOTSTRAP_ADMIN_ID,
      baseCountry: "MY",
      sourceId: source.id,
    });
    await insertJobScore(state.testDb, jobA1.id, resumeA1.id, {
      userId: BOOTSTRAP_ADMIN_ID,
      jdFacts: { hiringScope: "restricted", hiringCountries: ["Malaysia"] },
    });

    const { profileRepo } = await import("@/server/persistence/repos/profile");
    const getSpy = vi.spyOn(profileRepo, "get");

    const result = await recomputeEligibility();

    expect(result.total).toBe(2);
    // Two jobs, same owner -> profileRepo.get called exactly once (cached).
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(getSpy).toHaveBeenCalledWith(BOOTSTRAP_ADMIN_ID);

    getSpy.mockRestore();
    void jobA2;
  });
});
