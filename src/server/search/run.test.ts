import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LlmClient } from "@/lib/llm/client";
import { makeMockLlm } from "@/lib/llm/mock";
import { insertProfile, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { createSearchRunsRepo, type SearchRunRow } from "@/server/persistence/repos/searchRuns";
import { crawlRuns, creditLedger, jobs, jobScores, postings, resumes, searchRuns, sources, users } from "@/server/persistence/schema";
import type { NewPosting } from "@/server/persistence/repos/postings";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";
import { balance, grant, InsufficientCreditsError } from "@/server/credits";
import { ScanFrame, type JobPhaseData, type SourceEventData } from "@/types";

// P.5 pool cutover: discovery is a read of the shared `postings` pool, not a
// per-source connector fan-out. Tests seed the pool directly (insertPosting)
// and inject only the LLM (deps.llm) — the connector stubs / concurrency /
// connectorTimeout deps are GONE. Scoring is still wired in (B6), so a scripted
// LLM mock covers both stages; no network in tests.
const testLlm = makeMockLlm({
  "jd-extract": {
    title: "Data Engineer",
    isJobPosting: true,
    company: null,
    seniority: null,
    employmentType: null,
    location: null,
    remotePolicy: null,
    hiringScope: null,
    hiringCountries: null,
    salaryRange: null,
    mustHaves: ["SQL"],
    niceToHaves: [],
    responsibilities: ["Build pipelines"],
    redFlags: [],
    tzRequirement: null,
    hiringStructure: null,
    workCalendar: null,
  },
  "match-score": {
    score: 4.1,
    verdict: "Apply",
    why: "Strong data engineering overlap.",
    breakdown: [{ label: "Skills", value: 4.5 }],
    fit: [{ k: "SQL", v: "5 years" }],
    gaps: [],
    reasons: { for: ["Matches stack"], against: [] },
    legitimacy: { tier: "clear", summary: "Established company.", signals: [] },
    lowConfidence: false,
  },
});

// Finding 3 (daily cost cap): a non-zero-cost LlmClient so `spentToday` can
// actually cross `dailyCapUsd` inside a single run — `testLlm`/`makeMockLlm`
// always reports costUsd: 0, which can never trip the cap.
const costingLlm: LlmClient = {
  async complete(args) {
    if (args.task === "jd-extract") {
      return {
        data: args.responseSchema.parse({
          title: "Data Engineer",
          isJobPosting: true,
          company: null,
          seniority: null,
          employmentType: null,
          location: null,
          remotePolicy: null,
          hiringScope: null,
          hiringCountries: null,
          salaryRange: null,
          mustHaves: ["SQL"],
          niceToHaves: [],
          responsibilities: ["Build pipelines"],
          redFlags: [],
          tzRequirement: null,
          hiringStructure: null,
          workCalendar: null,
        }),
        model: "mock",
        costUsd: 0.01,
      };
    }
    return {
      data: args.responseSchema.parse({
        score: 4.1,
        verdict: "Apply",
        why: "Strong data engineering overlap.",
        breakdown: [{ label: "Skills", value: 4.5 }],
        fit: [{ k: "SQL", v: "5 years" }],
        gaps: [],
        reasons: { for: ["Matches stack"], against: [] },
        legitimacy: { tier: "clear", summary: "Established company.", signals: [] },
        lowConfidence: false,
      }),
      model: "mock",
      costUsd: 0.01,
    };
  },
};

// A match-score LlmClient that never settles on its own — it resolves ONLY
// when its AbortSignal fires. Proves (a) the hard-cap timer stays armed
// through the scoring phase and (b) handle.signal is threaded all the way to
// the LLM call.
const hangingLlm: LlmClient = {
  async complete(args) {
    if (args.signal?.aborted) throw new Error("llm call aborted (hard runtime cap)");
    return new Promise<never>((_resolve, reject) => {
      args.signal?.addEventListener("abort", () => reject(new Error("llm call aborted (hard runtime cap)")));
    });
  },
};

// Like hangingLlm but counts how many times the LLM was called — proves that
// a candidate whose pool slot opens AFTER the hard cap fired never reaches the
// LLM (no queue drain). Reset the counter at the top of the test that uses it.
let hangingLlmCalls = 0;
const countingHangingLlm: LlmClient = {
  async complete(args) {
    hangingLlmCalls += 1;
    if (args.signal?.aborted) throw new Error("llm call aborted (hard runtime cap)");
    return new Promise<never>((_resolve, reject) => {
      args.signal?.addEventListener("abort", () => reject(new Error("llm call aborted (hard runtime cap)")));
    });
  },
};

async function findJobByDedupeKey(db: TestDb, dedupeKey: string) {
  const [row] = await db.select().from(jobs).where(eq(jobs.dedupeKey, dedupeKey)).limit(1);
  return row;
}

async function jobsForDedupeKey(db: TestDb, dedupeKey: string) {
  return db.select().from(jobs).where(eq(jobs.dedupeKey, dedupeKey));
}

let postingCounter = 0;
// Seed a live pool posting. Defaults to a title the résumé's "Senior Data
// Engineer" targets match (roleFuzzyMatch) and that the function classifier
// resolves deterministically to "data" (no LLM `function-classify` call), so a
// hanging/mock LLM only ever sees jd-extract / match-score.
async function insertPosting(db: TestDb, sourceId: string, overrides: Partial<NewPosting> = {}) {
  postingCounter += 1;
  const key = `pool-ck-${postingCounter}`;
  const [row] = await db
    .insert(postings)
    .values({
      canonicalKey: key,
      url: `https://example.com/${key}`,
      sourceId,
      title: "Data Engineer",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      description: "Build data pipelines with SQL.",
      aliases: [],
      raw: {},
      ...overrides,
    })
    .returning();
  return row;
}

// Polls the raw table (not the userId-scoped repo) — used by both single- and
// multi-user tests; just needs "has this run finished".
async function waitForTerminal(_repo: ReturnType<typeof createSearchRunsRepo>, id: string): Promise<SearchRunRow> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const [row] = await state.testDb.select().from(searchRuns).where(eq(searchRuns.id, id)).limit(1);
    if (row && (row.status === "completed" || row.status === "failed")) return row;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`run ${id} did not reach a terminal state within the test timeout`);
}

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));
// No real liveness probe (no network in tests) — scoreTopCandidates calls
// this for every candidate it scores.
vi.mock("@/server/score/liveness", () => ({ probeLivenessDeep: vi.fn().mockResolvedValue("active") }));
// Rescan skip-gate tests need to assert scoreJob was/wasn't called without
// changing its real behavior — wrap it in a vi.fn() rather than replacing it.
vi.mock("@/server/score", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/score")>();
  return { ...actual, scoreJob: vi.fn(actual.scoreJob) };
});

const {
  startSearch,
  ActiveRunConflictError,
  NoActiveResumeError,
  UnknownSourceIdsError,
  sortCandidatesForRanking,
  rankCandidatesForScoring,
  TOP_N_CANDIDATES,
} = await import("./run");
const { __resetForTests, get: getRunHandle, getActiveRunForPersona } = await import("@/server/runs/registry");
const { scoreJob: scoreJobSpy } = await import("@/server/score");

const resumeFixture = {
  structured: {
    storeVersion: 2 as const,
    extractionPath: "text" as const,
    name: "Jane Doe",
    contact: [{ label: "email", value: "jane@example.com" }],
    summary: "Backend engineer.",
    experience: [{ company: "Old Co", title: "Senior Data Engineer", dates: "2020-Present", isCurrent: true, bullets: [] }],
    education: [],
    skills: [{ label: "Languages", items: ["TypeScript"] }],
    projects: [],
    certifications: [],
    languages: [],
    sections: [],
  },
  sourceKind: "paste" as const,
  isActive: true,
};

describe("startSearch", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
    await insertProfile(state.testDb); // startSearch requires the operator profile (spec §4)
  });

  afterEach(async () => {
    __resetForTests();
    // One shared libsql test DB (beforeAll) — clean every table a run touches
    // so a later test's pool read / listEnabledByPersona doesn't see earlier
    // rows. FK order: jobs (FK postings, onDelete set null) + job_scores (FK
    // jobs) first; postings (FK sources) before sources.
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(searchRuns);
    await state.testDb.delete(postings);
    await state.testDb.delete(crawlRuns);
    await state.testDb.delete(sources);
    await state.testDb.delete(resumes);
  });

  it("returns a queued SearchRun immediately, then completes: admits pool survivors, records per-source survivor counts", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });

    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });
    // A second scoped source with zero survivors — perSource is seeded with
    // every scoped source, so it reports {found: 0}, never absent.
    await insertSource(state.testDb, { id: "src-quiet", kind: "board", persona: "remote", config: { country: "MY" } });

    await insertPosting(state.testDb, good.id, { url: "https://example.com/jobs/1", title: "Data Engineer" });
    await insertPosting(state.testDb, good.id, { url: "https://example.com/jobs/2", title: "Product Designer" });

    const run = await startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote" }, { llm: testLlm });

    expect(run.status).toBe("queued");
    expect(run.persona).toBe("remote");

    const finalRow = await waitForTerminal(runsRepo, run.id);
    expect(finalRow.status).toBe("completed");
    expect(finalRow.stats.scanned).toBe(2); // pool rows considered (both remote postings)
    expect(finalRow.stats.matched).toBe(1); // stage-1 survivors ("Product Designer" shares no tokens)
    expect(finalRow.stats.scored).toBe(1);
    expect(finalRow.stats.worth).toBe(1); // testLlm's canned verdict is "Apply"
    expect(finalRow.stats.perSource).toEqual(
      expect.arrayContaining([
        { sourceId: "src-good", found: 1, errors: 0 }, // survivor count; no fetch, so errors stays 0
        { sourceId: "src-quiet", found: 0, errors: 0 },
      ]),
    );

    const admitted = await findJobByDedupeKey(state.testDb, "example.com/jobs/1");
    expect(admitted?.title).toBe("Data Engineer");
    expect(admitted?.company).toBe("Acme");
    expect(admitted?.sourceId).toBe("src-good");
    expect(admitted?.postingId).toBeTruthy(); // arch §3.4 — the posting FK is stamped at admission

    const notAdmitted = await findJobByDedupeKey(state.testDb, "example.com/jobs/2");
    expect(notAdmitted).toBeUndefined();
  });

  // Board-bypass DROPPED at cutover (spec P.5): the crawler fetches whole
  // boards unscoped, so the pool is uniformly unscoped and board-sourced
  // postings go through the SAME roleFuzzyMatch gate as ats — no bypass.
  it("board-sourced postings go through the same role matcher as ats (the pre-cutover board bypass is gone)", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const board = await insertSource(state.testDb, { id: "src-board", kind: "board", persona: "remote", config: { country: "MY" } });
    const ats = await insertSource(state.testDb, { id: "src-ats", kind: "ats", persona: "remote" });

    // "Warehouse Associate" shares zero tokens with "Senior Data Engineer" —
    // it must be rejected regardless of source kind now.
    await insertPosting(state.testDb, board.id, { url: "https://board.example.com/jobs/1", title: "Warehouse Associate" });
    await insertPosting(state.testDb, ats.id, { url: "https://ats.example.com/jobs/1", title: "Warehouse Associate" });

    const run = await startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote" }, { llm: testLlm });

    const finalRow = await waitForTerminal(runsRepo, run.id);
    expect(finalRow.status).toBe("completed");
    expect(finalRow.stats.scanned).toBe(2);
    expect(finalRow.stats.matched).toBe(0); // neither passes the matcher — no board leniency

    expect(await findJobByDedupeKey(state.testDb, "board.example.com/jobs/1")).toBeUndefined();
    expect(await findJobByDedupeKey(state.testDb, "ats.example.com/jobs/1")).toBeUndefined();
  });

  it("throws NoActiveResumeError when no résumé exists", async () => {
    const originalDb = state.testDb;
    state.testDb = await createTestDb(); // fresh, résumé-less DB
    const uuidSpy = vi.spyOn(crypto, "randomUUID").mockReturnValueOnce("00000000-0000-4000-8000-0000000dead1");
    await expect(startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote" })).rejects.toThrow(NoActiveResumeError);
    // Pre-flight rejection must evict the reserved handle, not leak it in the
    // registry Map (the synthetic terminal emit in startSearch's catch).
    expect(getRunHandle("00000000-0000-4000-8000-0000000dead1")).toBeUndefined();
    uuidSpy.mockRestore();
    state.testDb = originalDb;
  });

  it("throws UnknownSourceIdsError naming the unknown ids when sources includes an id outside the persona's enabled set", async () => {
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });

    let caught: unknown;
    try {
      await startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote", sources: ["src-good", "typo-id"] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnknownSourceIdsError);
    expect((caught as InstanceType<typeof UnknownSourceIdsError>).unknownIds).toEqual(["typo-id"]);
  });

  it("run-failure path: an unattributable runFanOut crash marks the row 'failed' and emits a terminal 'error' SSE event (not left stuck 'running')", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    // Malformed `structured` (missing `contact`/`experience`) simulates a
    // corrupted DB row — deriveRoleTargets throws synchronously inside
    // runFanOut, exercising the "last-resort net" path.
    await insertResume(state.testDb, {
      ...resumeFixture,
      structured: { name: "Jane Doe" } as unknown as typeof resumeFixture.structured,
      isActive: true,
    });
    await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });

    const runPromise = startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote" });
    // Subscribe via the synchronously-reserved persona slot (finding 4's fix)
    // before awaiting — guarantees we're listening before the crash.
    const reservedId = getActiveRunForPersona(BOOTSTRAP_ADMIN_ID, "remote")!;
    const handle = getRunHandle(reservedId)!;
    const events: string[] = [];
    handle.subscribe((event) => events.push(event.event));

    const run = await runPromise;
    expect(run.id).toBe(reservedId);

    const finalRow = await waitForTerminal(runsRepo, run.id);
    expect(finalRow.status).toBe("failed");
    expect(finalRow.error).toBeTruthy();
    expect(events).toContain("error");
    expect(getActiveRunForPersona(BOOTSTRAP_ADMIN_ID, "remote")).toBeUndefined();
  });

  it("throws ActiveRunConflictError with the running run's id when a run is already active for that persona", async () => {
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });
    await insertPosting(state.testDb, good.id);

    // First run hangs in scoring (hangingLlm) so its persona slot stays
    // reserved while the second start races it; the hard cap ends it.
    const first = await startSearch(
      BOOTSTRAP_ADMIN_ID,
      { persona: "remote" },
      { llm: hangingLlm, hardRunTimeoutMs: 300 },
    );

    let caught: unknown;
    try {
      await startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ActiveRunConflictError);
    expect((caught as InstanceType<typeof ActiveRunConflictError>).activeRunId).toBe(first.id);
  });

  it("the 409 active-run mutex is per-user (Fable design review) — A's active run for a persona does NOT block B from starting one", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });
    await insertPosting(state.testDb, good.id);

    const [userB] = await state.testDb
      .insert(users)
      .values({ email: "user-b-search-mutex@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    await insertProfile(state.testDb, { id: "profile-b", userId: userB.id });
    await insertResume(state.testDb, { ...resumeFixture, userId: userB.id, isActive: true });
    await grant(userB.id, 30, "admin");

    // A starts a slow (hangs-in-scoring) run for "remote" — reserves A's slot.
    await startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote" }, { llm: hangingLlm, hardRunTimeoutMs: 300 });

    // B starting a run for the SAME persona must NOT see A's active run.
    const bRun = await startSearch(userB.id, { persona: "remote" }, { llm: hangingLlm, hardRunTimeoutMs: 300 });
    expect(bRun.status).toBe("queued");

    const bFinal = await waitForTerminal(runsRepo, bRun.id);
    expect(bFinal.userId).toBe(userB.id);
  });

  it("hard runtime cap covers scoring: a hung LLM call is aborted, the run still completes and releases its persona slot", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });
    await insertPosting(state.testDb, good.id, { url: "https://example.com/jobs/hang" });

    // Pool read finishes instantly; scoring then hangs in the first LLM call.
    // The 100ms hard cap must fire DURING scoring, abort the LLM call, and let
    // the run complete (0 scored).
    const run = await startSearch(
      BOOTSTRAP_ADMIN_ID,
      { persona: "remote" },
      { llm: hangingLlm, hardRunTimeoutMs: 100 },
    );

    const finalRow = await waitForTerminal(runsRepo, run.id);
    expect(finalRow.status).toBe("completed");
    expect(finalRow.stats.scored).toBe(0);
    expect(getActiveRunForPersona(BOOTSTRAP_ADMIN_ID, "remote")).toBeUndefined();
  });

  it("hard runtime cap: candidates whose slot opens after the abort skip scoring entirely (no queue drain)", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });

    // Two candidates, single-slot pool: candidate 1 opens its slot and hangs in
    // the LLM call; the 100ms cap fires and aborts it (call #1). Candidate 2's
    // slot then opens with the signal already aborted — it must bail BEFORE
    // touching the LLM, so exactly ONE llm.complete call happens total.
    hangingLlmCalls = 0;
    await insertPosting(state.testDb, good.id, { url: "https://example.com/jobs/drain-1", company: "Acme" });
    await insertPosting(state.testDb, good.id, { url: "https://example.com/jobs/drain-2", company: "Beta Corp" });

    const run = await startSearch(
      BOOTSTRAP_ADMIN_ID,
      { persona: "remote" },
      { llm: countingHangingLlm, scoreConcurrency: 1, hardRunTimeoutMs: 100 },
    );

    const finalRow = await waitForTerminal(runsRepo, run.id);
    expect(finalRow.status).toBe("completed");
    expect(finalRow.stats.scored).toBe(0);
    expect(hangingLlmCalls).toBe(1); // candidate 2 bailed at slot open, never reached the LLM
  });

  it("B6 integration: scores top-N candidates and streams ordered progress(score/legitimacy)…job…done SSE, with stats.worth/ghosts populated", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });
    await insertPosting(state.testDb, good.id, { url: "https://example.com/jobs/integration" });

    const runPromise = startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote" }, { llm: testLlm });
    const reservedId = getActiveRunForPersona(BOOTSTRAP_ADMIN_ID, "remote")!;
    const handle = getRunHandle(reservedId)!;
    const events: { event: string; data: unknown }[] = [];
    handle.subscribe((event) => events.push({ event: event.event, data: event.data }));

    const run = await runPromise;
    const finalRow = await waitForTerminal(runsRepo, run.id);

    expect(finalRow.status).toBe("completed");
    expect(finalRow.stats.scored).toBe(1);
    expect(finalRow.stats.worth).toBe(1);
    expect(finalRow.stats.ghosts).toBe(0);
    expect(finalRow.stats.capStopped).toBe(false);

    const order = events.map((e) => e.event);
    expect(order[0]).toBe("progress"); // "Reading the global postings pool…"
    expect(order[order.length - 1]).toBe("done");
    expect(order).toContain("job");
    const jobIndex = order.indexOf("job");
    const legitimacyIndex = events.findIndex(
      (e) => e.event === "progress" && (e.data as { stage: string }).stage === "legitimacy",
    );
    expect(legitimacyIndex).toBeGreaterThan(jobIndex);
    expect(order[order.length - 2]).toBe("progress"); // legitimacy stage right before done

    const scoreStages = events.filter((e) => e.event === "progress" && (e.data as { stage: string }).stage === "score");
    expect(scoreStages.length).toBeGreaterThan(0);

    const jobEvent = events.find((e) => e.event === "job")!;
    expect((jobEvent.data as { verdict: string }).verdict).toBe("Apply");
    expect((jobEvent.data as { legitimacy: { tier: string } }).legitimacy.tier).toBe("clear");
  });

  it("emits a synthetic 'pool' source lane + jobPhase deltas and leaves a coherent final frame (M2)", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });
    await insertPosting(state.testDb, good.id, { url: "https://example.com/jobs/a" });

    const runPromise = startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote" }, { llm: costingLlm });
    const reservedId = getActiveRunForPersona(BOOTSTRAP_ADMIN_ID, "remote")!;
    const handle = getRunHandle(reservedId)!;
    const events: { event: string; data: unknown }[] = [];
    handle.subscribe((event) => events.push({ event: event.event, data: event.data }));

    const run = await runPromise;
    await waitForTerminal(runsRepo, run.id);

    const sourceEvents = events.filter((e) => e.event === "source");
    expect(sourceEvents.map((e) => (e.data as SourceEventData).status)).toContain("done");
    const phases = events
      .filter((e) => e.event === "jobPhase" && (e.data as JobPhaseData).jobId)
      .map((e) => (e.data as JobPhaseData).phase);
    expect(phases).toEqual(expect.arrayContaining(["readingJD", "scoring", "done"]));

    // Final frame is absolute + coherent: the ONE synthetic pool lane settled
    // 'done', the scored job left the active set, and the counts add up.
    const frame = ScanFrame.parse(handle.frame);
    expect(frame.sources).toEqual([{ sourceId: "pool", name: "Global postings pool", status: "done", found: 1 }]);
    expect(frame.activeJobs).toEqual([]);
    expect(frame.counts).toEqual({ scored: 1, queued: 0, total: 1 });
  });

  it("daily cost cap: per-job gate stops scoring once dailyCapUsd is crossed (rolling pool, single slot), still completes", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });

    // Four matching candidates (distinct companies → 4 separate jobs).
    // costingLlm charges 0.02/job; scoreConcurrency:1 makes the rolling pool
    // strictly sequential, so job1 (0→0.02) and job2 (0.02→0.04) score, but
    // job3's gate sees 0.04 >= 0.025 and bails → 2 scored.
    for (const n of [1, 2, 3, 4]) {
      await insertPosting(state.testDb, good.id, { url: `https://example.com/jobs/cap-${n}`, company: `Co${n}` });
    }

    const run = await startSearch(
      BOOTSTRAP_ADMIN_ID,
      { persona: "remote" },
      { llm: costingLlm, dailyCapUsd: 0.025, scoreConcurrency: 1 },
    );

    const finalRow = await waitForTerminal(runsRepo, run.id);
    expect(finalRow.status).toBe("completed");
    expect(finalRow.stats.matched).toBe(4);
    expect(finalRow.stats.scored).toBe(2); // per-job gate stops after 2, not 3
    expect(finalRow.stats.capStopped).toBe(true);
  });

  it("rolling pool: every candidate is scored, aggregating a mix of success and EmptyJobDescriptionError", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });

    // 3 candidates: 2 with a pooled JD score normally; the 3rd's posting has
    // NO description, and the fixture/registry connector supplies no fetchDetail,
    // so ensureDescription leaves it empty and scoreJob throws
    // EmptyJobDescriptionError -> counted unscored, not a tolerated failure.
    await insertPosting(state.testDb, good.id, { url: "https://example.com/jobs/mix-1", company: "Acme" });
    await insertPosting(state.testDb, good.id, { url: "https://example.com/jobs/mix-2", company: "Beta Corp" });
    await insertPosting(state.testDb, good.id, { url: "https://example.com/jobs/mix-3", company: "Gamma Corp", description: null });

    const run = await startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote" }, { llm: testLlm });

    const finalRow = await waitForTerminal(runsRepo, run.id);

    expect(finalRow.status).toBe("completed");
    expect(finalRow.stats.matched).toBe(3);
    expect(finalRow.stats.scored).toBe(2);
    expect(finalRow.stats.worth).toBe(2); // testLlm's canned verdict is "Apply"
    expect(finalRow.stats.ghosts).toBe(0);
    expect(finalRow.stats.unscored).toBe(1);
    expect(finalRow.stats.capStopped).toBe(false);
  });

  it("persists a ScanResult per settled candidate incrementally + records stage durations and cost", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });
    await insertPosting(state.testDb, good.id, { url: "https://example.com/jobs/a", company: "Acme" });
    await insertPosting(state.testDb, good.id, { url: "https://example.com/jobs/b", company: "Beta" });

    const run = await startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote" }, { llm: costingLlm });
    const finalRow = await waitForTerminal(runsRepo, run.id);

    expect(finalRow.status).toBe("completed");
    expect(finalRow.results).toHaveLength(2);
    expect(finalRow.results.every((r) => r.outcome === "scored")).toBe(true);
    expect(finalRow.results[0]).toMatchObject({ company: expect.any(String), verdict: expect.any(String), source: good.id });
    expect(typeof finalRow.results[0].scoredMs).toBe("number");
    expect(finalRow.stats.discoverMs).toBeGreaterThanOrEqual(0);
    expect(finalRow.stats.scoreMs).toBeGreaterThanOrEqual(0);
    expect(finalRow.stats.costUsd).toBeCloseTo(0.04, 5); // costingLlm charges 0.02/job × 2
    expect(typeof finalRow.stats.policyVersion).toBe("string");
  });

  it("failRun persists accumulated stats + partial results when the run crashes mid-scoring", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });
    await insertPosting(state.testDb, good.id, { url: "https://example.com/jobs/a", company: "Acme" });

    // afterScoring: first job scores, then the write path is poisoned to force
    // runFanOut into failRun.
    const run = await startSearch(
      BOOTSTRAP_ADMIN_ID,
      { persona: "remote" },
      { llm: costingLlm, afterScoring: () => { throw new Error("boom"); } },
    );
    const finalRow = await waitForTerminal(runsRepo, run.id);

    expect(finalRow.status).toBe("failed");
    expect(finalRow.error).toContain("boom");
    expect(finalRow.results).toHaveLength(1); // the job that settled before the crash
    expect(finalRow.stats.scored).toBe(1); // accumulated, not zeroed
  });

  it("cap-hit run persists skipped:dailyCap result rows for the un-scored top candidates", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });
    for (const n of [1, 2, 3, 4]) {
      await insertPosting(state.testDb, good.id, { url: `https://example.com/jobs/cap-${n}`, company: `Co${n}` });
    }
    const run = await startSearch(
      BOOTSTRAP_ADMIN_ID,
      { persona: "remote" },
      { llm: costingLlm, dailyCapUsd: 0.025, scoreConcurrency: 1 },
    );
    const finalRow = await waitForTerminal(runsRepo, run.id);

    expect(finalRow.status).toBe("completed");
    expect(finalRow.stats.capStopped).toBe(true);
    const scored = finalRow.results.filter((r) => r.outcome === "scored");
    const skipped = finalRow.results.filter((r) => r.outcome === "skipped" && r.reason === "dailyCap");
    expect(scored).toHaveLength(2);
    expect(skipped).toHaveLength(2); // the 2 candidates the gate bailed on are recorded, not dropped
  });

  it("rescan skip gate: a job already scored for the active résumé+policy is not re-scored (perf/scan-overhead)", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });
    await insertPosting(state.testDb, good.id, { url: "https://example.com/jobs/rescan-skip" });

    const run1 = await startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote" }, { llm: testLlm });
    await waitForTerminal(runsRepo, run1.id);

    vi.mocked(scoreJobSpy).mockClear();
    const run2 = await startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote" }, { llm: testLlm });
    const finalRow2 = await waitForTerminal(runsRepo, run2.id);

    expect(finalRow2.status).toBe("completed");
    expect(finalRow2.stats.scored).toBe(0);
    expect(vi.mocked(scoreJobSpy)).not.toHaveBeenCalled();
    expect(finalRow2.results).toHaveLength(1);
    expect(finalRow2.results[0]).toMatchObject({ outcome: "skipped", reason: "alreadyScored" });
  });

  it("rescan skip gate: a résumé swap still triggers a real rescore for the same job (different resumeId, same policy)", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    const resumeA = await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });
    await insertPosting(state.testDb, good.id, { url: "https://example.com/jobs/rescan-resume-swap" });

    const run1 = await startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote" }, { llm: testLlm });
    await waitForTerminal(runsRepo, run1.id);

    // Swap the active résumé — mirrors resumesRepo.create's deactivate-then-insert.
    await state.testDb.update(resumes).set({ isActive: false }).where(eq(resumes.id, resumeA.id));
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });

    vi.mocked(scoreJobSpy).mockClear();
    const run2 = await startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote" }, { llm: testLlm });
    const finalRow2 = await waitForTerminal(runsRepo, run2.id);

    expect(finalRow2.status).toBe("completed");
    expect(finalRow2.stats.scored).toBe(1);
    expect(vi.mocked(scoreJobSpy)).toHaveBeenCalledTimes(1);
    expect(finalRow2.results[0]).toMatchObject({ outcome: "scored" });
  });

  it("admission debit (membership spec §4.2): debits 10 credits with refId = the run id", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    const [user] = await state.testDb
      .insert(users)
      .values({ email: "credits-scan@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    await insertProfile(state.testDb, { id: "profile-credits-scan", userId: user.id });
    await insertResume(state.testDb, { ...resumeFixture, userId: user.id, isActive: true });
    await grant(user.id, 30, "admin");

    const run = await startSearch(user.id, { persona: "remote" });
    await waitForTerminal(runsRepo, run.id);

    expect(await balance(user.id)).toBe(20);
    const rows = await state.testDb.select().from(creditLedger).where(eq(creditLedger.userId, user.id));
    const debitRow = rows.find((r) => r.reason === "debit");
    expect(debitRow?.feature).toBe("scan");
    expect(debitRow?.refId).toBe(run.id);
  });

  it("admission debit: insufficient balance throws InsufficientCreditsError and no search_runs row exists afterward", async () => {
    const [user] = await state.testDb
      .insert(users)
      .values({ email: "credits-scan-broke@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    await insertProfile(state.testDb, { id: "profile-credits-scan-broke", userId: user.id });
    await insertResume(state.testDb, { ...resumeFixture, userId: user.id, isActive: true });
    // No grant — balance 0, "scan" costs 10.

    await expect(startSearch(user.id, { persona: "remote" })).rejects.toThrow(InsufficientCreditsError);

    const rows = await state.testDb.select().from(searchRuns).where(eq(searchRuns.userId, user.id));
    expect(rows).toHaveLength(0);
    expect(await balance(user.id)).toBe(0);
  });

  it("admission debit: does NOT debit when pre-flight fails (no résumé) — balance unchanged after NoActiveResumeError", async () => {
    const [user] = await state.testDb
      .insert(users)
      .values({ email: "credits-scan-noresume@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    await insertProfile(state.testDb, { id: "profile-credits-scan-noresume", userId: user.id });
    await grant(user.id, 30, "admin");
    // Deliberately no résumé for this user.

    await expect(startSearch(user.id, { persona: "remote" })).rejects.toThrow(NoActiveResumeError);
    expect(await balance(user.id)).toBe(30);
  });

  it("admission debit: admin bypass debits nothing (zero ledger rows) for the bootstrap admin", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    await insertSource(state.testDb, { id: "src-admin-bypass", kind: "ats", persona: "remote" });

    const run = await startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote" });
    await waitForTerminal(runsRepo, run.id);

    const rows = await state.testDb.select().from(creditLedger).where(eq(creditLedger.userId, BOOTSTRAP_ADMIN_ID));
    expect(rows).toHaveLength(0);
  });

  // ── P.5 pool-cutover pins ──────────────────────────────────────────────

  it("P.5: a pool posting passing stage-1 is admitted to the user's jobs EXACTLY once, stamping postingId, and its JD reaches scoring FROM the posting (no re-fetch)", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });
    const posting = await insertPosting(state.testDb, good.id, {
      url: "https://example.com/jobs/admit-once",
      description: "SENTINEL-JD build data pipelines with SQL.",
    });

    const run = await startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote" }, { llm: testLlm });
    const finalRow = await waitForTerminal(runsRepo, run.id);
    expect(finalRow.status).toBe("completed");
    expect(finalRow.stats.scored).toBe(1);

    const admittedRows = await jobsForDedupeKey(state.testDb, "example.com/jobs/admit-once");
    expect(admittedRows).toHaveLength(1); // exactly once
    expect(admittedRows[0].postingId).toBe(posting.id); // P.1 FK stamped
    // JD reached scoring via the posting's crawl-time text (ensureDescription
    // posting-first), persisted onto the job right before scoring.
    expect(admittedRows[0].description).toContain("SENTINEL-JD");
    // tz_band is READ FROM the posting (crawl-stamped), not re-derived.
    expect(admittedRows[0].tzBand).toBe(posting.tzBand);
  });

  it("P.5 / DECISION A: an out-of-band posting is DEMOTED, never dropped pre-score — it is still admitted and scored", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    const [user] = await state.testDb
      .insert(users)
      .values({ email: "p5-nodrop@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    // base-hours → allowedBands ["apac"] (americas is out-of-band); relocation
    // "open" isolates the tz signal from the relocation-abroad pre-score drop.
    await insertProfile(state.testDb, {
      id: "profile-p5-nodrop",
      userId: user.id,
      scheduleFlex: "base-hours",
      relocation: "open",
    });
    await insertResume(state.testDb, { ...resumeFixture, userId: user.id, isActive: true });
    await grant(user.id, 30, "admin");
    const good = await insertSource(state.testDb, { id: "src-nodrop", kind: "ats", persona: "remote" });
    await insertPosting(state.testDb, good.id, { url: "https://example.com/jobs/americas", tzBand: "americas" });

    const run = await startSearch(user.id, { persona: "remote" }, { llm: testLlm });
    const finalRow = await waitForTerminal(runsRepo, run.id);

    expect(finalRow.status).toBe("completed");
    expect(finalRow.stats.matched).toBe(1);
    expect(finalRow.stats.scored).toBe(1); // NOT dropped on the tz_band signal
    // Admitted + scored is the whole proof: pre-cutover an out-of-band job was
    // filtered before scoring and (never scored) never surfaced in the feed —
    // a de-facto hide. (Admission's tz_band stamp is transient here: the
    // scoring path's Layer-C remote-fit refresh re-resolves it from JD facts.)
    const admitted = await findJobByDedupeKey(state.testDb, "example.com/jobs/americas");
    expect(admitted).toBeTruthy();
  });

  it("P.5 / F4: a stale crawl (>48h) emits a fail-loud staleness warning on the scan SSE", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });
    await state.testDb.insert(crawlRuns).values({
      status: "completed",
      startedAt: new Date(Date.now() - 4 * 24 * 3600 * 1000),
      finishedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000), // 72h old > 48h
    });

    const runPromise = startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote" }, { llm: testLlm });
    const reservedId = getActiveRunForPersona(BOOTSTRAP_ADMIN_ID, "remote")!;
    const handle = getRunHandle(reservedId)!;
    const labels: string[] = [];
    handle.subscribe((event) => {
      if (event.event === "progress") labels.push((event.data as { label: string }).label);
    });

    const run = await runPromise;
    await waitForTerminal(runsRepo, run.id);

    expect(labels.some((l) => /stale/i.test(l))).toBe(true);
  });

  it("P.5 / F4: a fresh crawl (<48h) emits NO staleness warning", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });
    await state.testDb.insert(crawlRuns).values({
      status: "completed",
      startedAt: new Date(Date.now() - 3600 * 1000),
      finishedAt: new Date(), // fresh
    });

    const runPromise = startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote" }, { llm: testLlm });
    const reservedId = getActiveRunForPersona(BOOTSTRAP_ADMIN_ID, "remote")!;
    const handle = getRunHandle(reservedId)!;
    const labels: string[] = [];
    handle.subscribe((event) => {
      if (event.event === "progress") labels.push((event.data as { label: string }).label);
    });

    const run = await runPromise;
    await waitForTerminal(runsRepo, run.id);

    expect(labels.some((l) => /stale|freshness unknown/i.test(l))).toBe(false);
  });
});

// Task 1.2: the top-N slice (scoreTopCandidates ranking) must be a pure
// function of posting content — NOT of the order postings land in the `pool`
// array. postedAt desc (nulls last) + dedupeKey asc is deterministic.
describe("sortCandidatesForRanking (Task 1.2 — deterministic top-N ranking)", () => {
  type MinimalCandidate = { job: { postedAt: Date | null; dedupeKey: string } };

  function candidate(dedupeKey: string, postedAt: Date | null): MinimalCandidate {
    return { job: { postedAt, dedupeKey } };
  }

  // Deterministic seeded PRNG (LCG) — NOT unseeded Math.random. Produces a
  // fixed, reproducible permutation per seed.
  function seededShuffle<T>(arr: T[], seed: number): T[] {
    const out = [...arr];
    let s = seed;
    for (let i = out.length - 1; i > 0; i--) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const j = s % (i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  it("top-30 slice is byte-identical (same postings, same order) across shuffled insertion orders", () => {
    const base = Date.now();
    const candidates: MinimalCandidate[] = [
      ...Array.from({ length: 20 }, (_, i) => candidate(`distinct-${String(i).padStart(2, "0")}`, new Date(base + (20 - i) * 1000))),
      ...Array.from({ length: 10 }, (_, i) => candidate(`tie-${String(i).padStart(2, "0")}`, new Date(base))),
      ...Array.from({ length: 10 }, (_, i) => candidate(`null-${String(i).padStart(2, "0")}`, null)),
    ];
    expect(candidates.length).toBeGreaterThan(TOP_N_CANDIDATES);

    const expectedTop30 = sortCandidatesForRanking(candidates).slice(0, TOP_N_CANDIDATES);
    expect(expectedTop30.some((c) => c.job.postedAt === null)).toBe(false);
    expect(expectedTop30.map((c) => c.job.dedupeKey).slice(20, 30)).toEqual(
      Array.from({ length: 10 }, (_, i) => `tie-${String(i).padStart(2, "0")}`),
    );

    for (const seed of [1, 2, 3, 4, 5]) {
      const shuffled = seededShuffle(candidates, seed);
      expect(shuffled.map((c) => c.job.dedupeKey)).not.toEqual(candidates.map((c) => c.job.dedupeKey));

      const top30 = sortCandidatesForRanking(shuffled).slice(0, TOP_N_CANDIDATES);
      expect(top30).toEqual(expectedTop30);
    }
  });
});

// DECISION A (operator, 2026-07-17, full soft rank): a stated-but-out-of-band
// tz_band must no longer drop a candidate pre-score — it demotes.
describe("rankCandidatesForScoring (DECISION A — tz_band demotes, never drops)", () => {
  type MinimalCandidate = { job: { postedAt: Date | null; dedupeKey: string; tzBand: "apac" | "emea" | "americas" | null } };

  function candidate(dedupeKey: string, tzBand: MinimalCandidate["job"]["tzBand"]): MinimalCandidate {
    return { job: { postedAt: null, dedupeKey, tzBand } };
  }

  it("a misaligned candidate is NOT dropped — it survives in the returned pool", () => {
    const aligned = candidate("aligned-apac", "apac");
    const misaligned = candidate("misaligned-americas", "americas");
    const allowedBands: ("apac" | "emea" | "americas")[] = ["apac"];

    const ranked = rankCandidatesForScoring([aligned, misaligned], allowedBands);

    expect(ranked.map((c) => c.job.dedupeKey)).toEqual(
      expect.arrayContaining(["aligned-apac", "misaligned-americas"]),
    );
    expect(ranked).toHaveLength(2);
  });

  it("an aligned candidate ranks above a misaligned one, even when the misaligned one would otherwise sort first", () => {
    const misaligned = { job: { postedAt: new Date("2026-01-02"), dedupeKey: "a-misaligned", tzBand: "americas" as const } };
    const aligned = { job: { postedAt: new Date("2026-01-01"), dedupeKey: "z-aligned", tzBand: "apac" as const } };
    const allowedBands: ("apac" | "emea" | "americas")[] = ["apac"];

    const ranked = rankCandidatesForScoring([misaligned, aligned], allowedBands);

    expect(ranked.map((c) => c.job.dedupeKey)).toEqual(["z-aligned", "a-misaligned"]);
  });

  it("a NULL (unstated) tz_band is always aligned — ranks with the aligned group", () => {
    const unstated = candidate("unstated", null);
    const misaligned = candidate("misaligned", "americas");
    const allowedBands: ("apac" | "emea" | "americas")[] = ["apac"];

    const ranked = rankCandidatesForScoring([misaligned, unstated], allowedBands);

    expect(ranked.map((c) => c.job.dedupeKey)).toEqual(["unstated", "misaligned"]);
  });

  it("allowedBands: null (e.g. scheduleFlex any-hours) treats every band as aligned — order is untouched by tz_band", () => {
    const americas = candidate("americas", "americas");
    const emea = candidate("emea", "emea");

    const ranked = rankCandidatesForScoring([americas, emea], null);

    expect(ranked).toHaveLength(2);
    expect(ranked.map((c) => c.job.dedupeKey)).toEqual(
      expect.arrayContaining(["americas", "emea"]),
    );
  });
});
