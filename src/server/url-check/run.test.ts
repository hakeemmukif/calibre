import { describe, expect, it, vi } from "vitest";
import { makeMockLlm } from "@/lib/llm/mock";
import {
  insertProfile,
  insertResume,
  insertSource,
  insertJob,
  insertJobScore,
} from "@/server/persistence/repos/__fixtures__/helpers";
import { createJobsRepo } from "@/server/persistence/repos/jobs";
import { createUrlChecksRepo } from "@/server/persistence/repos/urlChecks";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { dedupeKeyFor } from "@/server/search/dedupe";
import { scoreJob } from "@/server/score";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));
vi.mock("@/server/score/liveness", () => ({ probeLivenessDeep: vi.fn().mockResolvedValue("active") }));
// The worker singleton must never run for real in this file: startUrlCheck's
// admission tests call urlCheckWorker.kick() at the end, and without this
// mock that would drain the mocked test DB through the REAL pipeline deps
// (real getLlm/fetchPageText) — hitting the network. Pipeline behavior is
// covered by driving runPipeline directly (see below), never through kick().
vi.mock("./worker", () => ({ urlCheckWorker: { kick: vi.fn().mockResolvedValue(undefined) } }));

const {
  startUrlCheck,
  getUrlCheck,
  assemble,
  runPipeline,
  PayloadTooLargeError,
  FetchBlockedError,
  NotAJobPostingError,
  ExtractionIncompleteError,
  ManualSourceMissingError,
} = await import("./run");
const { NoActiveResumeError } = await import("@/server/search/run");

// The state a claim would leave: a running row with attempts=1, ready for
// runPipeline to drive directly (bypassing admission and the worker).
async function insertRunningCheck(db: TestDb, req: { url: string; text?: string }): Promise<string> {
  const repo = createUrlChecksRepo(db);
  const row = await repo.insert({
    userId: BOOTSTRAP_ADMIN_ID,
    id: crypto.randomUUID(),
    url: req.url,
    dedupeKey: dedupeKeyFor(req.url),
    status: "running",
    stage: null,
    jobId: null,
    alreadyKnown: false,
    needsText: false,
    error: null,
    costUsd: 0,
    raw: { text: req.text ?? null },
    attempts: 1,
  });
  return row.id;
}

describe("assemble", () => {
  it("round-trips a queued row into the wire UrlCheck shape", async () => {
    const db = await createTestDb();
    state.testDb = db;
    const repo = createUrlChecksRepo(db);
    const row = await repo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
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
  it("rejects with NoActiveResumeError before any pipeline work when no résumé is active", async () => {
    const db = await createTestDb();
    state.testDb = db;

    await expect(startUrlCheck({ url: "https://example.com/job" })).rejects.toThrow(NoActiveResumeError);
  });

  it("rejects PayloadTooLargeError for pasted text over the 40k cap", async () => {
    const db = await createTestDb();
    state.testDb = db;
    await insertResume(db, { isActive: true });

    await expect(
      startUrlCheck({ url: "https://example.com/job", text: "x".repeat(40_001) }),
    ).rejects.toThrow(PayloadTooLargeError);
  });

  it("dedupe short-circuit: existing SCORED job -> 200-shaped alreadyKnown, no pipeline started", async () => {
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

    const { check, started } = await startUrlCheck({ url: "https://example.com/already-known" });

    expect(started).toBe(false);
    expect(check.status).toBe("completed");
    expect(check.alreadyKnown).toBe(true);
    expect(check.jobId).toBe(existing.id);
  });

  it("no existing job -> queued row returned immediately, started true", async () => {
    const db = await createTestDb();
    state.testDb = db;
    await insertResume(db, { isActive: true });

    const { check, started } = await startUrlCheck({ url: "https://example.com/brand-new" });

    expect(started).toBe(true);
    expect(check.status).toBe("queued");
    expect(check.alreadyKnown).toBe(false);
  });

  it("orphan self-healing: dedupe hit with NO score row is NOT short-circuited — admission queues it for the worker (final review fix wave FIX 1a)", async () => {
    const db = await createTestDb();
    state.testDb = db;
    await insertResume(db, { isActive: true });
    await insertSource(db, { id: "manual", kind: "manual", persona: "both", enabled: false, config: {} });
    const orphanJobsRepo = createJobsRepo(db);
    const orphan = await insertJob(db, "manual", {
      dedupeKey: "example.com/orphan",
      url: "https://example.com/orphan",
      persona: "pasted",
    });
    expect(await orphanJobsRepo.hasAnyScore(orphan.id)).toBe(false);

    const { check, started } = await startUrlCheck({ url: "https://example.com/orphan" });

    expect(started).toBe(true);
    expect(check.status).toBe("queued");
    expect(check.alreadyKnown).toBe(false);
  });
});

async function setUpForPipeline(db: TestDb) {
  const resumeRow = await insertResume(db, { isActive: true });
  const profile = await insertProfile(db);
  await insertSource(db, { id: "manual", kind: "manual", persona: "both", enabled: false, config: {} });
  return { resumeRow, profile };
}

const jdExtractLlm = (data: Record<string, unknown>) => makeMockLlm({ "jd-extract": data });

describe("runPipeline — needsText truth table", () => {
  it("tier-1 fetch ok + gate ok -> completed, no tier-2 search call", async () => {
    const db = await createTestDb();
    state.testDb = db;
    const { resumeRow, profile } = await setUpForPipeline(db);
    const searchSpy = vi.fn();
    const checkId = await insertRunningCheck(db, { url: "https://example.com/tier1-ok" });

    await runPipeline(checkId, { url: "https://example.com/tier1-ok" }, {
      llm: jdExtractLlm({ title: "Backend Engineer", company: "Acme", isJobPosting: true, mustHaves: [], niceToHaves: [], responsibilities: [], redFlags: [] }),
      resumeRow, profile, attempt: 1,
      deps: {
        fetchPageText: async () => ({ ok: true, text: "Acme is hiring a Backend Engineer.", pageTitle: "Acme Careers" }),
        searchForPosting: searchSpy,
        fetchGhostWebEvidence: async () => ({ webEvidence: { status: "ok", sightings: [], companySignals: [], summary: "Looks fine.", confidence: 0.6 }, costUsd: 0 }),
        scoreJob: async () => ({ costUsd: 0.02 }) as unknown as ReturnType<typeof scoreJob> extends Promise<infer T> ? T : never,
      },
    });

    const finalRow = await createUrlChecksRepo(db).getById(checkId);
    expect(finalRow?.status).toBe("completed");
    expect(finalRow?.needsText).toBe(false);
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("tier-1 gate throws -> escalates -> tier-2 found:false -> FETCH_BLOCKED, needsText:true", async () => {
    const db = await createTestDb();
    state.testDb = db;
    const { resumeRow, profile } = await setUpForPipeline(db);
    const checkId = await insertRunningCheck(db, { url: "https://example.com/tier1-throws" });

    await runPipeline(checkId, { url: "https://example.com/tier1-throws" }, {
      llm: makeMockLlm(() => {
        throw new Error("authwall garbage");
      }),
      resumeRow, profile, attempt: 1,
      deps: {
        fetchPageText: async () => ({ ok: true, text: "log in to continue", pageTitle: undefined }),
        searchForPosting: async () => ({ found: false, content: "", sourceNote: "", costUsd: 0.01 }),
        fetchGhostWebEvidence: vi.fn(),
        scoreJob: vi.fn(),
      },
    });

    const finalRow = await createUrlChecksRepo(db).getById(checkId);
    expect(finalRow?.status).toBe("failed");
    expect(finalRow?.error).toEqual({ code: "FETCH_BLOCKED", message: expect.any(String) });
    expect(finalRow?.needsText).toBe(true);
  });

  it("tier-1 fetch blocked -> tier-2 found:true, isJobPosting:false -> NOT_A_JOB_POSTING, needsText:false", async () => {
    const db = await createTestDb();
    state.testDb = db;
    const { resumeRow, profile } = await setUpForPipeline(db);
    const checkId = await insertRunningCheck(db, { url: "https://example.com/not-a-posting" });

    await runPipeline(checkId, { url: "https://example.com/not-a-posting" }, {
      llm: jdExtractLlm({ title: "n/a", isJobPosting: false, company: null, mustHaves: [], niceToHaves: [], responsibilities: [], redFlags: [] }),
      resumeRow, profile, attempt: 1,
      deps: {
        fetchPageText: async () => ({ ok: false, reason: "blocked" }),
        searchForPosting: async () => ({ found: true, content: "This is a marketing landing page.", sourceNote: "found via search", costUsd: 0.01 }),
        fetchGhostWebEvidence: vi.fn(),
        scoreJob: vi.fn(),
      },
    });

    const finalRow = await createUrlChecksRepo(db).getById(checkId);
    expect(finalRow?.status).toBe("failed");
    expect(finalRow?.error?.code).toBe("NOT_A_JOB_POSTING");
    expect(finalRow?.needsText).toBe(false);
  });

  it("tier-2 found:true, gate incomplete (no company) -> EXTRACTION_FAILED, needsText:true", async () => {
    const db = await createTestDb();
    state.testDb = db;
    const { resumeRow, profile } = await setUpForPipeline(db);
    const checkId = await insertRunningCheck(db, { url: "https://example.com/incomplete" });

    await runPipeline(checkId, { url: "https://example.com/incomplete" }, {
      llm: jdExtractLlm({ title: "Backend Engineer", isJobPosting: true, company: null, mustHaves: [], niceToHaves: [], responsibilities: [], redFlags: [] }), // no company
      resumeRow, profile, attempt: 1,
      deps: {
        fetchPageText: async () => ({ ok: false, reason: "empty" }),
        searchForPosting: async () => ({ found: true, content: "Some thin posting text.", sourceNote: "found via search", costUsd: 0.01 }),
        fetchGhostWebEvidence: vi.fn(),
        scoreJob: vi.fn(),
      },
    });

    const finalRow = await createUrlChecksRepo(db).getById(checkId);
    expect(finalRow?.status).toBe("failed");
    expect(finalRow?.error?.code).toBe("EXTRACTION_FAILED");
    expect(finalRow?.needsText).toBe(true);
  });

  it("paste mode: isJobPosting:false -> NOT_A_JOB_POSTING", async () => {
    const db = await createTestDb();
    state.testDb = db;
    const { resumeRow, profile } = await setUpForPipeline(db);
    const checkId = await insertRunningCheck(db, {
      url: "https://example.com/pasted-not-a-posting",
      text: "Just some random article text.",
    });

    await runPipeline(checkId, { url: "https://example.com/pasted-not-a-posting", text: "Just some random article text." }, {
      llm: jdExtractLlm({ title: "n/a", isJobPosting: false, company: null, mustHaves: [], niceToHaves: [], responsibilities: [], redFlags: [] }),
      resumeRow, profile, attempt: 1,
      deps: { fetchPageText: vi.fn(), searchForPosting: vi.fn(), fetchGhostWebEvidence: vi.fn(), scoreJob: vi.fn() },
    });

    const finalRow = await createUrlChecksRepo(db).getById(checkId);
    expect(finalRow?.error?.code).toBe("NOT_A_JOB_POSTING");
    expect(finalRow?.needsText).toBe(false);
  });

  it("paste mode: LLM omits isJobPosting entirely (mock schema-rejects, mirroring the live gpt-oss-120b bug) -> EXTRACTION_FAILED, needsText:true", async () => {
    const db = await createTestDb();
    state.testDb = db;
    const { resumeRow, profile } = await setUpForPipeline(db);
    const checkId = await insertRunningCheck(db, {
      url: "https://example.com/pasted-omitted-field",
      text: "Company: Front\n\nSenior Engineer...",
    });

    await runPipeline(checkId, { url: "https://example.com/pasted-omitted-field", text: "Company: Front\n\nSenior Engineer..." }, {
      // No isJobPosting key at all — under JdFactsSchema (optional) this
      // used to parse fine and silently produce "incomplete"; under
      // JdFactsGateSchema (required) makeMockLlm's own responseSchema.parse
      // throws, which runGate's paste-mode caller maps to
      // ExtractionIncompleteError just like a real upstream failure.
      llm: jdExtractLlm({ title: "Senior Engineer", company: "Front", mustHaves: [], niceToHaves: [], responsibilities: [], redFlags: [] }),
      resumeRow, profile, attempt: 1,
      deps: { fetchPageText: vi.fn(), searchForPosting: vi.fn(), fetchGhostWebEvidence: vi.fn(), scoreJob: vi.fn() },
    });

    const finalRow = await createUrlChecksRepo(db).getById(checkId);
    expect(finalRow?.error?.code).toBe("EXTRACTION_FAILED");
    expect(finalRow?.needsText).toBe(true);
  });

  it("paste mode: gate throws -> EXTRACTION_FAILED, needsText:true (fuller paste may fix it)", async () => {
    const db = await createTestDb();
    state.testDb = db;
    const { resumeRow, profile } = await setUpForPipeline(db);
    const checkId = await insertRunningCheck(db, { url: "https://example.com/pasted-throws", text: "garbled text" });

    await runPipeline(checkId, { url: "https://example.com/pasted-throws", text: "garbled text" }, {
      llm: makeMockLlm(() => {
        throw new Error("model didn't answer");
      }),
      resumeRow, profile, attempt: 1,
      deps: { fetchPageText: vi.fn(), searchForPosting: vi.fn(), fetchGhostWebEvidence: vi.fn(), scoreJob: vi.fn() },
    });

    const finalRow = await createUrlChecksRepo(db).getById(checkId);
    expect(finalRow?.error?.code).toBe("EXTRACTION_FAILED");
    expect(finalRow?.needsText).toBe(true);
  });
});

describe("runPipeline — persisting edge cases", () => {
  it("concurrent scan race: upsert returns a non-manual sourceId -> alreadyKnown, no ghost-check/score", async () => {
    const db = await createTestDb();
    state.testDb = db;
    const { resumeRow, profile } = await setUpForPipeline(db);
    const scanSource = await insertSource(db, { id: "greenhouse", kind: "ats" });
    const jobsRepo = createJobsRepo(db);
    // Simulate the race directly: pre-seed the SAME dedupe key under the
    // scanned source before the pipeline's own upsert runs.
    const raced = await jobsRepo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
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
    const checkId = await insertRunningCheck(db, { url: "https://example.com/race" }); // SAME url as `raced` above

    await runPipeline(checkId, { url: "https://example.com/race" }, {
      llm: jdExtractLlm({ title: "Backend Engineer", company: "Acme", isJobPosting: true, mustHaves: [], niceToHaves: [], responsibilities: [], redFlags: [] }),
      resumeRow, profile, attempt: 1,
      deps: {
        fetchPageText: async () => ({ ok: true, text: "Acme hiring.", pageTitle: undefined }),
        searchForPosting: vi.fn(),
        fetchGhostWebEvidence: ghostSpy,
        scoreJob: scoreSpy,
      },
    });

    // `raced` has no score row, so admission's hasAnyScore gate (final
    // review fix wave FIX 1a) does NOT short-circuit it at admission —
    // the pipeline actually runs and hits the mid-pipeline
    // job.sourceId !== "manual" race branch (Step 7), closing the
    // "accepted gap" this test used to note (it previously only hit the
    // admission shortcut by accident, never the real race branch).
    const finalRow = await createUrlChecksRepo(db).getById(checkId);
    expect(finalRow?.status).toBe("completed");
    expect(finalRow?.alreadyKnown).toBe(true);
    expect(finalRow?.jobId).toBe(raced.id);
    expect(ghostSpy).not.toHaveBeenCalled();
    expect(scoreSpy).not.toHaveBeenCalled();
  });

  it("ghost-web failure is tolerated: pipeline still completes and scoreJob still receives status:'failed' webEvidence", async () => {
    const db = await createTestDb();
    state.testDb = db;
    const { resumeRow, profile } = await setUpForPipeline(db);
    let receivedWebEvidence: unknown;
    const checkId = await insertRunningCheck(db, { url: "https://example.com/ghost-fails" });

    await runPipeline(checkId, { url: "https://example.com/ghost-fails" }, {
      llm: jdExtractLlm({ title: "Backend Engineer", company: "Acme", isJobPosting: true, mustHaves: [], niceToHaves: [], responsibilities: [], redFlags: [] }),
      resumeRow, profile, attempt: 1,
      deps: {
        fetchPageText: async () => ({ ok: true, text: "Acme hiring.", pageTitle: undefined }),
        searchForPosting: vi.fn(),
        fetchGhostWebEvidence: async () => ({ webEvidence: { status: "failed", reason: "sonar timed out" }, costUsd: 0 }),
        scoreJob: async (args) => {
          receivedWebEvidence = await args.webEvidence;
          return { costUsd: 0.02 } as unknown as ReturnType<typeof scoreJob> extends Promise<infer T> ? T : never;
        },
      },
    });

    const finalRow = await createUrlChecksRepo(db).getById(checkId);
    expect(finalRow?.status).toBe("completed");
    expect(receivedWebEvidence).toEqual({ status: "failed", reason: "sonar timed out" });
  });

  it("manual source missing -> failed INTERNAL naming npm run db:seed", async () => {
    const db = await createTestDb();
    state.testDb = db;
    const resumeRow = await insertResume(db, { isActive: true });
    const profile = await insertProfile(db);
    // deliberately NOT seeding the "manual" source
    const checkId = await insertRunningCheck(db, { url: "https://example.com/no-manual-source" });

    await runPipeline(checkId, { url: "https://example.com/no-manual-source" }, {
      llm: jdExtractLlm({ title: "Backend Engineer", company: "Acme", isJobPosting: true, mustHaves: [], niceToHaves: [], responsibilities: [], redFlags: [] }),
      resumeRow, profile, attempt: 1,
      deps: {
        fetchPageText: async () => ({ ok: true, text: "Acme hiring.", pageTitle: undefined }),
        searchForPosting: vi.fn(),
        fetchGhostWebEvidence: vi.fn(),
        scoreJob: vi.fn(),
      },
    });

    const finalRow = await createUrlChecksRepo(db).getById(checkId);
    expect(finalRow?.status).toBe("failed");
    expect(finalRow?.error?.code).toBe("INTERNAL");
    expect(finalRow?.error?.message).toContain("npm run db:seed");
    expect(finalRow?.needsText).toBe(false);
  });

  it("scoreJob throws -> failed UPSTREAM_LLM_ERROR, needsText:false", async () => {
    const db = await createTestDb();
    state.testDb = db;
    const { resumeRow, profile } = await setUpForPipeline(db);
    const checkId = await insertRunningCheck(db, { url: "https://example.com/score-throws" });

    await runPipeline(checkId, { url: "https://example.com/score-throws" }, {
      llm: jdExtractLlm({ title: "Backend Engineer", company: "Acme", isJobPosting: true, mustHaves: [], niceToHaves: [], responsibilities: [], redFlags: [] }),
      resumeRow, profile, attempt: 1,
      deps: {
        fetchPageText: async () => ({ ok: true, text: "Acme hiring.", pageTitle: undefined }),
        searchForPosting: vi.fn(),
        fetchGhostWebEvidence: async () => ({ webEvidence: { status: "ok", sightings: [], companySignals: [], summary: "ok", confidence: 0.5 }, costUsd: 0 }),
        scoreJob: async () => {
          throw new Error("model refused");
        },
      },
    });

    const finalRow = await createUrlChecksRepo(db).getById(checkId);
    expect(finalRow?.status).toBe("failed");
    expect(finalRow?.error?.code).toBe("UPSTREAM_LLM_ERROR");
    expect(finalRow?.needsText).toBe(false);
  });

  it("orphan self-healing: pipeline upsert on an existing NO-score job completes as a real score (not alreadyKnown), same dedupeKey (final review fix wave FIX 1a)", async () => {
    const db = await createTestDb();
    state.testDb = db;
    const { resumeRow, profile } = await setUpForPipeline(db);
    const orphanJobsRepo = createJobsRepo(db);
    const orphan = await insertJob(db, "manual", {
      dedupeKey: "example.com/orphan",
      url: "https://example.com/orphan",
      persona: "pasted",
    });
    expect(await orphanJobsRepo.hasAnyScore(orphan.id)).toBe(false);
    const checkId = await insertRunningCheck(db, { url: "https://example.com/orphan" });

    await runPipeline(checkId, { url: "https://example.com/orphan" }, {
      llm: jdExtractLlm({ title: "Backend Engineer", company: "Acme", isJobPosting: true, mustHaves: [], niceToHaves: [], responsibilities: [], redFlags: [] }),
      resumeRow, profile, attempt: 1,
      deps: {
        fetchPageText: async () => ({ ok: true, text: "Acme hiring.", pageTitle: undefined }),
        searchForPosting: vi.fn(),
        fetchGhostWebEvidence: async () => ({ webEvidence: { status: "ok", sightings: [], companySignals: [], summary: "ok", confidence: 0.5 }, costUsd: 0 }),
        scoreJob: async () => ({ costUsd: 0.02 }) as unknown as ReturnType<typeof scoreJob> extends Promise<infer T> ? T : never,
      },
    });

    const finalRow = await createUrlChecksRepo(db).getById(checkId);
    expect(finalRow?.status).toBe("completed");
    expect(finalRow?.jobId).toBe(orphan.id);
    expect(finalRow?.alreadyKnown).toBe(false);
  });
});

describe("run.ts is agnostic to the tier-1 LinkedIn guest-endpoint rewrite", () => {
  it("persists the job under the ORIGINAL LinkedIn url/dedupeKey, never the fetch-page-internal guest rewrite", async () => {
    const db = await createTestDb();
    state.testDb = db;
    const { resumeRow, profile } = await setUpForPipeline(db);
    const reqUrl = "https://www.linkedin.com/jobs/view/4388552365/";
    const checkId = await insertRunningCheck(db, { url: reqUrl });

    await runPipeline(checkId, { url: reqUrl }, {
      llm: jdExtractLlm({ title: "Software Engineer", company: "DHL", isJobPosting: true, mustHaves: [], niceToHaves: [], responsibilities: [], redFlags: [] }),
      resumeRow, profile, attempt: 1,
      deps: {
        fetchPageText: async () => ({ ok: true, text: "DHL is hiring a Software Engineer.", pageTitle: "Software Engineer (Fullstack Developer)" }),
        searchForPosting: vi.fn(),
        fetchGhostWebEvidence: async () => ({ webEvidence: { status: "ok", sightings: [], companySignals: [], summary: "ok", confidence: 0.6 }, costUsd: 0 }),
        scoreJob: async () => ({ costUsd: 0.02 }) as unknown as ReturnType<typeof scoreJob> extends Promise<infer T> ? T : never,
      },
    });

    const finalRow = await createUrlChecksRepo(db).getById(checkId);
    expect(finalRow?.status).toBe("completed");

    const persisted = await createJobsRepo(db).getByDedupeKey(dedupeKeyFor(reqUrl));
    expect(persisted).not.toBeNull();
    expect(persisted!.url).toBe(reqUrl);
    expect(persisted!.applyUrl).toBe(reqUrl);
    expect(persisted!.raw).toMatchObject({ acquisition: "fetch" });
    expect(finalRow?.jobId).toBe(persisted!.id);
  });
});
