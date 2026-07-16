import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MATCH_SCORE } from "@/lib/llm/scripted-fixtures";
import { insertJob, insertProfile, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { creditLedger, jobs, jobScores, resumes, sources, users } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { Job } from "@/types";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";
import { balance, grant, InsufficientCreditsError } from "@/server/credits";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));
vi.mock("./liveness", () => ({ probeLivenessDeep: vi.fn().mockResolvedValue("active") }));

const { evaluateJob, UnknownJobError } = await import("./evaluate");
const { EmptyJobDescriptionError } = await import("./index");
const { NoActiveResumeError } = await import("@/server/search/run");

describe("evaluateJob", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
    await insertProfile(state.testDb); // scoreJob's Layer-C refresh requires the operator profile
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(sources);
    await state.testDb.delete(resumes);
  });

  it("throws UnknownJobError for an unknown job id", async () => {
    await expect(evaluateJob(crypto.randomUUID(), BOOTSTRAP_ADMIN_ID)).rejects.toThrow(UnknownJobError);
  });

  it("throws UnknownJobError for a foreign-owned job id (404, never a leak)", async () => {
    const [userB] = await state.testDb
      .insert(users)
      .values({ email: "user-b-evaluate@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { description: "Backend role at Acme." });
    await insertResume(state.testDb, { isActive: true });

    await expect(evaluateJob(job.id, userB.id)).rejects.toThrow(UnknownJobError);
  });

  it("throws NoActiveResumeError when no résumé is active", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { description: "Backend role at Acme." });
    await insertResume(state.testDb); // isActive: false by default

    await expect(evaluateJob(job.id, BOOTSTRAP_ADMIN_ID)).rejects.toThrow(NoActiveResumeError);
  });

  it("happy path: returns a Job.parse-valid job whose score matches the scripted MATCH_SCORE fixture, and persists a job_scores row", async () => {
    vi.stubEnv("CALIBER_TEST_DOUBLES", "1");
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { description: "Backend role at Acme." });
    const resume = await insertResume(state.testDb, { isActive: true });

    const result = await evaluateJob(job.id, BOOTSTRAP_ADMIN_ID);

    expect(() => Job.parse(result)).not.toThrow();
    expect(result.id).toBe(job.id);
    expect(result.score).toBeCloseTo(MATCH_SCORE.score);

    const rows = await state.testDb.select().from(jobScores).where(eq(jobScores.jobId, job.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].resumeId).toBe(resume.id);
  });

  it("a null-description job with a no-fetchDetail source throws EmptyJobDescriptionError", async () => {
    vi.stubEnv("CALIBER_TEST_DOUBLES", "1");
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { description: null });
    await insertResume(state.testDb, { isActive: true });

    await expect(evaluateJob(job.id, BOOTSTRAP_ADMIN_ID)).rejects.toThrow(EmptyJobDescriptionError);
  });

  it("logs the detail-fetch failure and still throws EmptyJobDescriptionError when the connector's fetchDetail rejects", async () => {
    // Real jobstreet connector (not the fixture double, which has no
    // fetchDetail) so ensureDescription actually calls fetchDetail and
    // rejects — exercising evaluate.ts's .catch(), not describe.ts's
    // short-circuit for a connector with no fetchDetail at all.
    const source = await insertSource(state.testDb, { id: "jobstreet", kind: "board", persona: "local", config: {} });
    const job = await insertJob(state.testDb, source.id, {
      sourceId: source.id,
      url: "https://id.jobstreet.com/id/job/2",
      persona: "local",
      description: null,
    });
    await insertResume(state.testDb, { isActive: true });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // No CALIBER_TEST_DOUBLES here (it would also swap in the no-fetchDetail
    // fixture connector) — the LLM is never reached since scoreJob throws on
    // the null description first, but evaluateJob resolves `llm` eagerly, so
    // an unused stub is passed in directly instead of calling getLlm().
    const llm = { complete: vi.fn() };

    try {
      await expect(evaluateJob(job.id, BOOTSTRAP_ADMIN_ID, { llm })).rejects.toThrow(EmptyJobDescriptionError);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`evaluateJob ${job.id}: detail fetch failed:`),
        expect.any(Error),
      );
    } finally {
      errorSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("admission debit: debits 5 credits with refId = jobId on a successful evaluate", async () => {
    vi.stubEnv("CALIBER_TEST_DOUBLES", "1");
    const [user] = await state.testDb
      .insert(users)
      .values({ email: "credits-evaluate@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    await insertProfile(state.testDb, { id: "profile-credits-evaluate", userId: user.id });
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { userId: user.id, description: "Backend role at Acme." });
    await insertResume(state.testDb, { userId: user.id, isActive: true });
    await grant(user.id, 30, "admin");

    await evaluateJob(job.id, user.id);

    expect(await balance(user.id)).toBe(25);
    const rows = await state.testDb.select().from(creditLedger).where(eq(creditLedger.userId, user.id));
    const debitRow = rows.find((r) => r.reason === "debit");
    expect(debitRow?.feature).toBe("evaluate");
    expect(debitRow?.refId).toBe(job.id);
  });

  it("admission debit: UnknownJobError path debits nothing", async () => {
    const [user] = await state.testDb
      .insert(users)
      .values({ email: "credits-evaluate-unknown@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    await grant(user.id, 30, "admin");

    await expect(evaluateJob(crypto.randomUUID(), user.id)).rejects.toThrow(UnknownJobError);
    expect(await balance(user.id)).toBe(30);
  });

  it("admission debit: no-active-résumé path debits nothing (proves the debit sits after the résumé check)", async () => {
    const [user] = await state.testDb
      .insert(users)
      .values({ email: "credits-evaluate-noresume@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { userId: user.id, description: "Backend role at Acme." });
    await insertResume(state.testDb, { userId: user.id }); // isActive: false by default
    await grant(user.id, 30, "admin");

    await expect(evaluateJob(job.id, user.id)).rejects.toThrow(NoActiveResumeError);
    expect(await balance(user.id)).toBe(30);
  });

  it("admission debit: insufficient balance throws InsufficientCreditsError and writes no job_scores row", async () => {
    const [user] = await state.testDb
      .insert(users)
      .values({ email: "credits-evaluate-broke@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { userId: user.id, description: "Backend role at Acme." });
    await insertResume(state.testDb, { userId: user.id, isActive: true });
    // No grant — balance 0, "evaluate" costs 5.

    await expect(evaluateJob(job.id, user.id)).rejects.toThrow(InsufficientCreditsError);
    const rows = await state.testDb.select().from(jobScores).where(eq(jobScores.jobId, job.id));
    expect(rows).toHaveLength(0);
  });

  it("admission debit: admin bypass debits nothing (zero ledger rows) for the bootstrap admin", async () => {
    vi.stubEnv("CALIBER_TEST_DOUBLES", "1");
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { description: "Backend role at Acme." });
    await insertResume(state.testDb, { isActive: true });

    await evaluateJob(job.id, BOOTSTRAP_ADMIN_ID);

    const rows = await state.testDb.select().from(creditLedger).where(eq(creditLedger.userId, BOOTSTRAP_ADMIN_ID));
    expect(rows).toHaveLength(0);
  });
});
