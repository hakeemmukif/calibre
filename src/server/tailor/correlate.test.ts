import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeMockLlm } from "@/lib/llm/mock";
import { insertJob, insertJobScore, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { correlationReports, jobScores, jobs, resumes, sources } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { buildRequirements, correlate, NoJdFactsError } = await import("./correlate");
const { UnknownJobError, NoActiveResumeError } = await import("./errors");
const { correlationReportsRepo } = await import("@/server/persistence/repos/correlationReports");
const { __resetForTests } = await import("@/server/runs/registry");

async function pollUntilTerminal(id: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await correlationReportsRepo.getById(id, BOOTSTRAP_ADMIN_ID);
    if (row && (row.status === "completed" || row.status === "failed")) return row;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`correlate run ${id} did not reach a terminal state within the test timeout`);
}

describe("buildRequirements", () => {
  it("flattens mustHaves/niceToHaves/responsibilities with stable ids", () => {
    const reqs = buildRequirements({
      title: "x", mustHaves: ["a"], niceToHaves: ["b"], responsibilities: ["c"], redFlags: [],
    } as never);
    expect(reqs).toEqual([
      { id: 0, kind: "must", text: "a" },
      { id: 1, kind: "nice", text: "b" },
      { id: 2, kind: "responsibility", text: "c" },
    ]);
  });
});

describe("correlate", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  afterEach(async () => {
    __resetForTests();
    await state.testDb.delete(correlationReports);
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(resumes);
    await state.testDb.delete(sources);
  });

  it("404s (UnknownJobError) for an unknown job id", async () => {
    await expect(correlate(BOOTSTRAP_ADMIN_ID, { jobId: crypto.randomUUID() }, { llm: makeMockLlm({}) }))
      .rejects.toBeInstanceOf(UnknownJobError);
  });

  it("409s (NoActiveResumeError) when no résumé is active", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    await expect(correlate(BOOTSTRAP_ADMIN_ID, { jobId: job.id }, { llm: makeMockLlm({}) }))
      .rejects.toBeInstanceOf(NoActiveResumeError);
  });

  it("throws NoJdFactsError when the job was never scored", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    await insertResume(state.testDb, { isActive: true });
    await expect(correlate(BOOTSTRAP_ADMIN_ID, { jobId: job.id }, { llm: makeMockLlm({}) }))
      .rejects.toBeInstanceOf(NoJdFactsError);
  });

  it("completes: queued -> completed with verified rows and both signals", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, {
      isActive: true,
      structured: {
        storeVersion: 2, extractionPath: "text", name: "Jane Doe",
        contact: [{ label: "email", value: "jane@example.com" }],
        summary: "Backend engineer.",
        experience: [{
          company: "Acme Corp", title: "Senior Backend Engineer", dates: "2020–Present",
          isCurrent: true, bullets: ["Led distributed payments platform"],
        }],
        education: [], skills: [], projects: [], certifications: [], languages: [], sections: [],
      },
    });
    await insertJobScore(state.testDb, job.id, resume.id, {
      jdFacts: { title: "Backend Engineer", mustHaves: ["distributed"], niceToHaves: [], responsibilities: [], redFlags: [] },
    });

    const llm = makeMockLlm({
      correlate: {
        rows: [{ id: 0, term: "distributed", status: "met", evidence: "Led distributed payments platform", reason: "r", note: null }],
      },
    });

    const queued = await correlate(BOOTSTRAP_ADMIN_ID, { jobId: job.id }, { llm });
    expect(queued.status).toBe("queued");

    const row = await pollUntilTerminal(queued.id);
    expect(row.status).toBe("completed");
    expect(row.rows[0].status).toBe("met");
    expect(row.semantic?.total).toBe(row.rows.length);
    expect(row.ats?.total).toBe(row.rows.length);
  });

  it("downgrades an uncited claim to gap (fail-safe, not fail-open)", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true });
    await insertJobScore(state.testDb, job.id, resume.id, {
      jdFacts: { title: "Backend Engineer", mustHaves: ["kafka"], niceToHaves: [], responsibilities: [], redFlags: [] },
    });

    const llm = makeMockLlm({
      correlate: {
        rows: [{ id: 0, term: "kafka", status: "met", evidence: "Built Kafka streaming that isn't in the résumé", reason: "r", note: null }],
      },
    });

    const queued = await correlate(BOOTSTRAP_ADMIN_ID, { jobId: job.id }, { llm });
    const row = await pollUntilTerminal(queued.id);
    expect(row.status).toBe("completed");
    expect(row.rows[0].status).toBe("gap");
  });
});
