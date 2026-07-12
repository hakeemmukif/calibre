import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { LlmClient } from "@/lib/llm/client";
import { makeMockLlm } from "@/lib/llm/mock";
import {
  insertProfile,
  insertResume,
  insertSource,
  insertJob,
  insertJobScore,
} from "@/server/persistence/repos/__fixtures__/helpers";
import { createJobsRepo } from "@/server/persistence/repos/jobs";
import { createUrlChecksRepo, type UrlCheckRow } from "@/server/persistence/repos/urlChecks";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { scoreJob } from "@/server/score";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));
vi.mock("@/server/score/liveness", () => ({ probeLivenessDeep: vi.fn().mockResolvedValue("active") }));

const {
  startUrlCheck,
  getUrlCheck,
  assemble,
  PayloadTooLargeError,
  FetchBlockedError,
  NotAJobPostingError,
  ExtractionIncompleteError,
  ManualSourceMissingError,
} = await import("./run");
const { NoActiveResumeError } = await import("@/server/search/run");

async function waitForTerminal(db: TestDb, id: string): Promise<UrlCheckRow> {
  const repo = createUrlChecksRepo(db);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const row = await repo.getById(id);
    if (row && (row.status === "completed" || row.status === "failed")) return row;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`url_check ${id} did not reach a terminal state within the test timeout`);
}

function noCallLlm(calls: string[]): LlmClient {
  return {
    async complete(args) {
      calls.push(args.task);
      throw new Error(`unexpected llm.complete("${args.task}") call`);
    },
  };
}

describe("assemble", () => {
  it("round-trips a queued row into the wire UrlCheck shape", async () => {
    const db = await createTestDb();
    state.testDb = db;
    const repo = createUrlChecksRepo(db);
    const row = await repo.insert({
      id: crypto.randomUUID(),
      url: "https://example.com/job",
      dedupeKey: "example.com/job",
      status: "queued",
      stage: null,
      jobId: null,
      alreadyKnown: false,
      needsText: false,
      error: null,
      costUsd: 0,
      raw: { text: null },
    });

    const check = assemble(row);
    expect(check.id).toBe(row.id);
    expect(check.status).toBe("queued");
    expect(check.stage).toBeNull();
    expect(check.alreadyKnown).toBe(false);
    expect(check.finishedAt).toBeNull();
  });
});

describe("getUrlCheck", () => {
  it("returns null for an unknown id", async () => {
    const db = await createTestDb();
    state.testDb = db;
    expect(await getUrlCheck(crypto.randomUUID())).toBeNull();
  });
});

describe("startUrlCheck admission", () => {
  it("rejects with NoActiveResumeError before any LLM call when no résumé is active", async () => {
    const db = await createTestDb();
    state.testDb = db;
    const calls: string[] = [];

    await expect(
      startUrlCheck({ url: "https://example.com/job" }, { llm: noCallLlm(calls) }),
    ).rejects.toThrow(NoActiveResumeError);

    expect(calls).toEqual([]);
  });

  it("rejects PayloadTooLargeError for pasted text over the 40k cap, before any LLM call", async () => {
    const db = await createTestDb();
    state.testDb = db;
    await insertResume(db, { isActive: true });
    const calls: string[] = [];

    await expect(
      startUrlCheck({ url: "https://example.com/job", text: "x".repeat(40_001) }, { llm: noCallLlm(calls) }),
    ).rejects.toThrow(PayloadTooLargeError);

    expect(calls).toEqual([]);
  });

  it("dedupe short-circuit: existing SCORED job -> 200-shaped alreadyKnown, no LLM call, no pipeline started", async () => {
    const db = await createTestDb();
    state.testDb = db;
    const resume = await insertResume(db, { isActive: true });
    const source = await insertSource(db);
    const existing = await insertJob(db, source.id, {
      dedupeKey: "example.com/already-known",
      url: "https://example.com/already-known",
    });
    // Admission only short-circuits a dedupe hit that already has a score
    // (final review fix wave FIX 1a) — an unscored hit is the orphan case,
    // covered separately below.
    await insertJobScore(db, existing.id, resume.id);
    const calls: string[] = [];

    const { check, started } = await startUrlCheck(
      { url: "https://example.com/already-known" },
      { llm: noCallLlm(calls) },
    );

    expect(started).toBe(false);
    expect(check.status).toBe("completed");
    expect(check.alreadyKnown).toBe(true);
    expect(check.jobId).toBe(existing.id);
    expect(calls).toEqual([]);
  });

  it("no existing job -> queued row returned immediately, started true", async () => {
    const db = await createTestDb();
    state.testDb = db;
    await insertResume(db, { isActive: true });
    await insertProfile(db);
    const calls: string[] = [];

    const { check, started } = await startUrlCheck(
      { url: "https://example.com/brand-new" },
      {
        llm: noCallLlm(calls), // pipeline will fail fast (no "manual" source seeded) — fine, this test only asserts the synchronous admission return
        fetchPageText: async () => ({ ok: false, reason: "blocked" }),
        searchForPosting: async () => ({ found: false, content: "", sourceNote: "", costUsd: 0 }),
      },
    );

    expect(started).toBe(true);
    expect(check.status).toBe("queued");
    expect(check.alreadyKnown).toBe(false);

    const finalRow = await waitForTerminal(db, check.id);
    expect(finalRow.status).toBe("failed"); // ManualSourceMissingError -> INTERNAL, confirms the pipeline actually ran
  });

  it("orphan self-healing: dedupe hit with NO score row runs the pipeline (not alreadyKnown) and completes with a score (final review fix wave FIX 1a)", async () => {
    const db = await createTestDb();
    state.testDb = db;
    await setUpForPipeline(db);
    const orphanJobsRepo = createJobsRepo(db);
    const orphan = await insertJob(db, "manual", {
      dedupeKey: "example.com/orphan",
      url: "https://example.com/orphan",
      persona: "pasted",
    });
    expect(await orphanJobsRepo.hasAnyScore(orphan.id)).toBe(false);

    const { check, started } = await startUrlCheck(
      { url: "https://example.com/orphan" },
      {
        llm: jdExtractLlm({ title: "Backend Engineer", company: "Acme", isJobPosting: true, mustHaves: [], niceToHaves: [], responsibilities: [], redFlags: [] }),
        fetchPageText: async () => ({ ok: true, text: "Acme hiring.", pageTitle: undefined }),
        fetchGhostWebEvidence: async () => ({ webEvidence: { status: "ok", sightings: [], companySignals: [], summary: "ok", confidence: 0.5 }, costUsd: 0 }),
        scoreJob: async () => ({ costUsd: 0.02 }) as unknown as ReturnType<typeof scoreJob> extends Promise<infer T> ? T : never,
      },
    );

    expect(started).toBe(true);
    expect(check.status).toBe("queued");
    expect(check.alreadyKnown).toBe(false);

    const finalRow = await waitForTerminal(db, check.id);
    expect(finalRow.status).toBe("completed");
    expect(finalRow.jobId).toBe(orphan.id);
    expect(finalRow.alreadyKnown).toBe(false);
  });
});

async function setUpForPipeline(db: TestDb) {
  await insertResume(db, { isActive: true });
  await insertProfile(db);
  await insertSource(db, { id: "manual", kind: "manual", persona: "both", enabled: false, config: {} });
}

const jdExtractLlm = (data: Record<string, unknown>) => makeMockLlm({ "jd-extract": data });

describe("runPipeline — needsText truth table", () => {
  it("tier-1 fetch ok + gate ok -> completed, no tier-2 search call", async () => {
    const db = await createTestDb();
    state.testDb = db;
    await setUpForPipeline(db);
    const searchSpy = vi.fn();

    const { check } = await startUrlCheck(
      { url: "https://example.com/tier1-ok" },
      {
        llm: jdExtractLlm({ title: "Backend Engineer", company: "Acme", isJobPosting: true, mustHaves: [], niceToHaves: [], responsibilities: [], redFlags: [] }),
        fetchPageText: async () => ({ ok: true, text: "Acme is hiring a Backend Engineer.", pageTitle: "Acme Careers" }),
        searchForPosting: searchSpy,
        fetchGhostWebEvidence: async () => ({ webEvidence: { status: "ok", sightings: [], companySignals: [], summary: "Looks fine.", confidence: 0.6 }, costUsd: 0 }),
        scoreJob: async () => ({ costUsd: 0.02 }) as unknown as ReturnType<typeof scoreJob> extends Promise<infer T> ? T : never,
      },
    );

    const finalRow = await waitForTerminal(db, check.id);
    expect(finalRow.status).toBe("completed");
    expect(finalRow.needsText).toBe(false);
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("tier-1 gate throws -> escalates -> tier-2 found:false -> FETCH_BLOCKED, needsText:true", async () => {
    const db = await createTestDb();
    state.testDb = db;
    await setUpForPipeline(db);

    const { check } = await startUrlCheck(
      { url: "https://example.com/tier1-throws" },
      {
        llm: makeMockLlm(() => {
          throw new Error("authwall garbage");
        }),
        fetchPageText: async () => ({ ok: true, text: "log in to continue", pageTitle: undefined }),
        searchForPosting: async () => ({ found: false, content: "", sourceNote: "", costUsd: 0.01 }),
      },
    );

    const finalRow = await waitForTerminal(db, check.id);
    expect(finalRow.status).toBe("failed");
    expect(finalRow.error).toEqual({ code: "FETCH_BLOCKED", message: expect.any(String) });
    expect(finalRow.needsText).toBe(true);
  });

  it("tier-1 fetch blocked -> tier-2 found:true, isJobPosting:false -> NOT_A_JOB_POSTING, needsText:false", async () => {
    const db = await createTestDb();
    state.testDb = db;
    await setUpForPipeline(db);

    const { check } = await startUrlCheck(
      { url: "https://example.com/not-a-posting" },
      {
        llm: jdExtractLlm({ title: "n/a", isJobPosting: false, company: null, mustHaves: [], niceToHaves: [], responsibilities: [], redFlags: [] }),
        fetchPageText: async () => ({ ok: false, reason: "blocked" }),
        searchForPosting: async () => ({ found: true, content: "This is a marketing landing page.", sourceNote: "found via search", costUsd: 0.01 }),
      },
    );

    const finalRow = await waitForTerminal(db, check.id);
    expect(finalRow.status).toBe("failed");
    expect(finalRow.error?.code).toBe("NOT_A_JOB_POSTING");
    expect(finalRow.needsText).toBe(false);
  });

  it("tier-2 found:true, gate incomplete (no company) -> EXTRACTION_FAILED, needsText:true", async () => {
    const db = await createTestDb();
    state.testDb = db;
    await setUpForPipeline(db);

    const { check } = await startUrlCheck(
      { url: "https://example.com/incomplete" },
      {
        llm: jdExtractLlm({ title: "Backend Engineer", isJobPosting: true, company: null, mustHaves: [], niceToHaves: [], responsibilities: [], redFlags: [] }), // no company
        fetchPageText: async () => ({ ok: false, reason: "empty" }),
        searchForPosting: async () => ({ found: true, content: "Some thin posting text.", sourceNote: "found via search", costUsd: 0.01 }),
      },
    );

    const finalRow = await waitForTerminal(db, check.id);
    expect(finalRow.status).toBe("failed");
    expect(finalRow.error?.code).toBe("EXTRACTION_FAILED");
    expect(finalRow.needsText).toBe(true);
  });

  it("paste mode: isJobPosting:false -> NOT_A_JOB_POSTING", async () => {
    const db = await createTestDb();
    state.testDb = db;
    await setUpForPipeline(db);

    const { check } = await startUrlCheck(
      { url: "https://example.com/pasted-not-a-posting", text: "Just some random article text." },
      { llm: jdExtractLlm({ title: "n/a", isJobPosting: false, company: null, mustHaves: [], niceToHaves: [], responsibilities: [], redFlags: [] }) },
    );

    const finalRow = await waitForTerminal(db, check.id);
    expect(finalRow.error?.code).toBe("NOT_A_JOB_POSTING");
    expect(finalRow.needsText).toBe(false);
  });

  it("paste mode: LLM omits isJobPosting entirely (mock schema-rejects, mirroring the live gpt-oss-120b bug) -> EXTRACTION_FAILED, needsText:true", async () => {
    const db = await createTestDb();
    state.testDb = db;
    await setUpForPipeline(db);

    const { check } = await startUrlCheck(
      { url: "https://example.com/pasted-omitted-field", text: "Company: Front\n\nSenior Engineer..." },
      // No isJobPosting key at all — under JdFactsSchema (optional) this
      // used to parse fine and silently produce "incomplete"; under
      // JdFactsGateSchema (required) makeMockLlm's own responseSchema.parse
      // throws, which runGate's paste-mode caller maps to
      // ExtractionIncompleteError just like a real upstream failure.
      { llm: jdExtractLlm({ title: "Senior Engineer", company: "Front", mustHaves: [], niceToHaves: [], responsibilities: [], redFlags: [] }) },
    );

    const finalRow = await waitForTerminal(db, check.id);
    expect(finalRow.error?.code).toBe("EXTRACTION_FAILED");
    expect(finalRow.needsText).toBe(true);
  });

  it("paste mode: gate throws -> EXTRACTION_FAILED, needsText:true (fuller paste may fix it)", async () => {
    const db = await createTestDb();
    state.testDb = db;
    await setUpForPipeline(db);

    const { check } = await startUrlCheck(
      { url: "https://example.com/pasted-throws", text: "garbled text" },
      {
        llm: makeMockLlm(() => {
          throw new Error("model didn't answer");
        }),
      },
    );

    const finalRow = await waitForTerminal(db, check.id);
    expect(finalRow.error?.code).toBe("EXTRACTION_FAILED");
    expect(finalRow.needsText).toBe(true);
  });
});

describe("runPipeline — persisting edge cases", () => {
  it("concurrent scan race: upsert returns a non-manual sourceId -> alreadyKnown, no ghost-check/score", async () => {
    const db = await createTestDb();
    state.testDb = db;
    await setUpForPipeline(db);
    const scanSource = await insertSource(db, { id: "greenhouse", kind: "ats" });
    const jobsRepo = createJobsRepo(db);
    // Simulate the race directly: pre-seed the SAME dedupe key under the
    // scanned source before the pipeline's own upsert runs.
    const raced = await jobsRepo.upsertByDedupeKey({
      dedupeKey: "example.com/race",
      url: "https://example.com/race",
      sourceId: scanSource.id,
      title: "Backend Engineer",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "test fixture",
      aliases: [],
      raw: {},
    });
    const ghostSpy = vi.fn();
    const scoreSpy = vi.fn();

    const { check, started } = await startUrlCheck(
      { url: "https://example.com/race" }, // SAME url as `raced` above
      {
        llm: jdExtractLlm({ title: "Backend Engineer", company: "Acme", isJobPosting: true, mustHaves: [], niceToHaves: [], responsibilities: [], redFlags: [] }),
        fetchPageText: async () => ({ ok: true, text: "Acme hiring.", pageTitle: undefined }),
        fetchGhostWebEvidence: ghostSpy,
        scoreJob: scoreSpy,
      },
    );

    // `raced` has no score row, so admission's hasAnyScore gate (final
    // review fix wave FIX 1a) does NOT short-circuit it at admission —
    // the pipeline actually runs and hits the mid-pipeline
    // job.sourceId !== "manual" race branch (Step 7), closing the
    // "accepted gap" this test used to note (it previously only hit the
    // admission shortcut by accident, never the real race branch).
    expect(started).toBe(true);
    expect(check.status).toBe("queued");

    const finalRow = await waitForTerminal(db, check.id);
    expect(finalRow.status).toBe("completed");
    expect(finalRow.alreadyKnown).toBe(true);
    expect(finalRow.jobId).toBe(raced.id);
    expect(ghostSpy).not.toHaveBeenCalled();
    expect(scoreSpy).not.toHaveBeenCalled();
  });

  it("ghost-web failure is tolerated: pipeline still completes and scoreJob still receives status:'failed' webEvidence", async () => {
    const db = await createTestDb();
    state.testDb = db;
    await setUpForPipeline(db);
    let receivedWebEvidence: unknown;

    const { check } = await startUrlCheck(
      { url: "https://example.com/ghost-fails" },
      {
        llm: jdExtractLlm({ title: "Backend Engineer", company: "Acme", isJobPosting: true, mustHaves: [], niceToHaves: [], responsibilities: [], redFlags: [] }),
        fetchPageText: async () => ({ ok: true, text: "Acme hiring.", pageTitle: undefined }),
        fetchGhostWebEvidence: async () => ({ webEvidence: { status: "failed", reason: "sonar timed out" }, costUsd: 0 }),
        scoreJob: async (args) => {
          receivedWebEvidence = args.webEvidence;
          return { costUsd: 0.02 } as unknown as ReturnType<typeof scoreJob> extends Promise<infer T> ? T : never;
        },
      },
    );

    const finalRow = await waitForTerminal(db, check.id);
    expect(finalRow.status).toBe("completed");
    expect(receivedWebEvidence).toEqual({ status: "failed", reason: "sonar timed out" });
  });

  it("manual source missing -> failed INTERNAL naming npm run db:seed", async () => {
    const db = await createTestDb();
    state.testDb = db;
    await insertResume(db, { isActive: true });
    await insertProfile(db);
    // deliberately NOT seeding the "manual" source

    const { check } = await startUrlCheck(
      { url: "https://example.com/no-manual-source" },
      {
        llm: jdExtractLlm({ title: "Backend Engineer", company: "Acme", isJobPosting: true, mustHaves: [], niceToHaves: [], responsibilities: [], redFlags: [] }),
        fetchPageText: async () => ({ ok: true, text: "Acme hiring.", pageTitle: undefined }),
      },
    );

    const finalRow = await waitForTerminal(db, check.id);
    expect(finalRow.status).toBe("failed");
    expect(finalRow.error?.code).toBe("INTERNAL");
    expect(finalRow.error?.message).toContain("npm run db:seed");
    expect(finalRow.needsText).toBe(false);
  });

  it("scoreJob throws -> failed UPSTREAM_LLM_ERROR, needsText:false", async () => {
    const db = await createTestDb();
    state.testDb = db;
    await setUpForPipeline(db);

    const { check } = await startUrlCheck(
      { url: "https://example.com/score-throws" },
      {
        llm: jdExtractLlm({ title: "Backend Engineer", company: "Acme", isJobPosting: true, mustHaves: [], niceToHaves: [], responsibilities: [], redFlags: [] }),
        fetchPageText: async () => ({ ok: true, text: "Acme hiring.", pageTitle: undefined }),
        fetchGhostWebEvidence: async () => ({ webEvidence: { status: "ok", sightings: [], companySignals: [], summary: "ok", confidence: 0.5 }, costUsd: 0 }),
        scoreJob: async () => {
          throw new Error("model refused");
        },
      },
    );

    const finalRow = await waitForTerminal(db, check.id);
    expect(finalRow.status).toBe("failed");
    expect(finalRow.error?.code).toBe("UPSTREAM_LLM_ERROR");
    expect(finalRow.needsText).toBe(false);
  });
});
