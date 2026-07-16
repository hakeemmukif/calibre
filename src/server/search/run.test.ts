import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LlmClient } from "@/lib/llm/client";
import { makeMockLlm } from "@/lib/llm/mock";
import { insertProfile, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { createSearchRunsRepo, type SearchRunRow } from "@/server/persistence/repos/searchRuns";
import { jobs, jobScores, resumes, searchRuns, sources, users } from "@/server/persistence/schema";
import type { SourceRow } from "@/server/persistence/repos/sources";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import type { RawPosting, SourceConnector } from "./connector";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";
import { ScanFrame, type JobPhaseData, type SourceEventData } from "@/types";

// Scoring is wired into the run (B6) — every startSearch() call that
// actually upserts a matched job reaches scoreTopCandidates, which needs an
// LlmClient. No network in tests: a scripted mock covering both stages.
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
// the LLM call. Under the pre-M0 code (timer cleared after discovery, signal
// not threaded) `args.signal` is undefined here, so this hangs until the
// test's waitForTerminal deadline and the test fails.
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

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));
// No real liveness probe (no network in tests) — scoreTopCandidates calls
// this for every candidate it scores.
vi.mock("@/server/score/liveness", () => ({ probeLivenessDeep: vi.fn().mockResolvedValue("active") }));

const { startSearch, ActiveRunConflictError, NoActiveResumeError, UnknownSourceIdsError } = await import("./run");
const { __resetForTests, get: getRunHandle, getActiveRunForPersona } = await import("@/server/runs/registry");

type StubBehavior = RawPosting[] | { fail: Error } | "hang-until-aborted";

function stubConnector(source: SourceRow, behavior: StubBehavior): SourceConnector {
  return {
    id: source.id,
    kind: source.kind,
    persona: source.persona,
    async *discover(ctx) {
      if (behavior === "hang-until-aborted") {
        // Check the already-aborted case explicitly — an 'abort' listener
        // added after the signal already fired never triggers.
        if (ctx.signal.aborted) throw new Error("connector aborted (hard runtime cap)");
        await new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new Error("connector aborted (hard runtime cap)")));
        });
        return;
      }
      if (!Array.isArray(behavior)) throw behavior.fail;
      for (const p of behavior) {
        ctx.onProgress({ stage: "fetch", current: 1, total: 1, label: p.title });
        yield p;
      }
    },
  };
}

// Polls the raw table (not the userId-scoped repo) — this helper is used by
// both single- and multi-user tests below and just needs "has this run
// finished", regardless of which user owns it.
async function waitForTerminal(_repo: ReturnType<typeof createSearchRunsRepo>, id: string): Promise<SearchRunRow> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const [row] = await state.testDb.select().from(searchRuns).where(eq(searchRuns.id, id)).limit(1);
    if (row && (row.status === "completed" || row.status === "failed")) return row;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`run ${id} did not reach a terminal state within the test timeout`);
}

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
    // Every test shares one libsql test DB (beforeAll) — without this, a
    // later test's listEnabledByPersona("remote") would also see earlier
    // tests' source rows. job_scores (B6) FKs jobs, so it must go first.
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(searchRuns);
    await state.testDb.delete(sources);
    await state.testDb.delete(resumes);
  });

  it("returns a queued SearchRun immediately, then completes: upserts matched jobs, records stats.perSource incl. a partial failure", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });

    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });
    await insertSource(state.testDb, { id: "src-bad", kind: "board", persona: "remote", config: { country: "MY" } });

    const matching: RawPosting = {
      sourceId: good.id,
      url: "https://example.com/jobs/1",
      title: "Data Engineer",
      company: "Acme",
      location: "Remote",
      description: "Build data pipelines with SQL.",
    };
    const nonMatching: RawPosting = {
      sourceId: good.id,
      url: "https://example.com/jobs/2",
      title: "Product Designer",
      company: "Acme",
      location: "Remote",
    };

    const run = await startSearch(BOOTSTRAP_ADMIN_ID, 
      { persona: "remote" },
      {
        concurrency: 5,
        connectorTimeoutMs: 500,
        hardRunTimeoutMs: 3000,
        llm: testLlm,
        connectorForSource: (source) =>
          source.id === "src-good"
            ? stubConnector(source, [matching, nonMatching])
            : stubConnector(source, { fail: new Error("board unreachable") }),
      },
    );

    expect(run.status).toBe("queued");
    expect(run.persona).toBe("remote");

    const finalRow = await waitForTerminal(runsRepo, run.id);
    expect(finalRow.status).toBe("completed");
    expect(finalRow.stats.scanned).toBe(2);
    expect(finalRow.stats.matched).toBe(1);
    expect(finalRow.stats.scored).toBe(1);
    expect(finalRow.stats.worth).toBe(1); // testLlm's canned verdict is "Apply"
    expect(finalRow.stats.perSource).toEqual(
      expect.arrayContaining([
        { sourceId: "src-good", found: 2, errors: 0 },
        { sourceId: "src-bad", found: 0, errors: 1 },
      ]),
    );

    const upserted = await findJobByDedupeKey(state.testDb, "example.com/jobs/1");
    expect(upserted?.title).toBe("Data Engineer");
    expect(upserted?.company).toBe("Acme");
    expect(upserted?.sourceId).toBe("src-good");

    const notUpserted = await findJobByDedupeKey(state.testDb, "example.com/jobs/2");
    expect(notUpserted).toBeUndefined();
  });

  it("board-kind sources bypass the role matcher; ats-kind sources still require a match (task-7b)", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const board = await insertSource(state.testDb, { id: "src-board", kind: "board", persona: "remote", config: { country: "MY" } });
    const ats = await insertSource(state.testDb, { id: "src-ats", kind: "ats", persona: "remote" });

    // "Warehouse Associate" shares zero tokens with the résumé's "Senior Data
    // Engineer" — roleFuzzyMatch would reject it from either source.
    const boardPosting: RawPosting = {
      sourceId: board.id,
      url: "https://board.example.com/jobs/1",
      title: "Warehouse Associate",
      company: "Acme",
      location: "Remote",
      description: "Manage warehouse inventory.",
    };
    const atsPosting: RawPosting = {
      sourceId: ats.id,
      url: "https://ats.example.com/jobs/1",
      title: "Warehouse Associate",
      company: "Beta Corp",
      location: "Remote",
      description: "Manage warehouse inventory.",
    };

    const run = await startSearch(BOOTSTRAP_ADMIN_ID, 
      { persona: "remote" },
      {
        llm: testLlm,
        connectorForSource: (source) =>
          source.id === "src-board" ? stubConnector(source, [boardPosting]) : stubConnector(source, [atsPosting]),
      },
    );

    const finalRow = await waitForTerminal(runsRepo, run.id);
    expect(finalRow.status).toBe("completed");
    expect(finalRow.stats.scanned).toBe(2);
    expect(finalRow.stats.matched).toBe(1); // only the board posting bypasses the matcher

    const boardJob = await findJobByDedupeKey(state.testDb, "board.example.com/jobs/1");
    expect(boardJob?.title).toBe("Warehouse Associate");

    const atsJob = await findJobByDedupeKey(state.testDb, "ats.example.com/jobs/1");
    expect(atsJob).toBeUndefined();
  });

  it("throws NoActiveResumeError when no résumé exists", async () => {
    const originalDb = state.testDb;
    state.testDb = await createTestDb(); // fresh, résumé-less DB
    await expect(startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote" })).rejects.toThrow(NoActiveResumeError);
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
    // runFanOut, outside the per-connector try/catch that tolerates
    // connector-level failures, exercising the "last-resort net" path.
    await insertResume(state.testDb, {
      ...resumeFixture,
      structured: { name: "Jane Doe" } as unknown as typeof resumeFixture.structured,
      isActive: true,
    });
    await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });

    const runPromise = startSearch(BOOTSTRAP_ADMIN_ID, 
      { persona: "remote" },
      { connectorForSource: (source) => stubConnector(source, []) },
    );
    // Subscribe via the synchronously-reserved persona slot (finding 4's
    // fix) before awaiting — guarantees we're listening before the crash,
    // which only happens after an internal DB await resolves.
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
    await insertSource(state.testDb, { id: "src-slow", kind: "ats", persona: "remote" });

    const first = await startSearch(BOOTSTRAP_ADMIN_ID, 
      { persona: "remote" },
      { connectorForSource: (s) => stubConnector(s, "hang-until-aborted"), hardRunTimeoutMs: 200 },
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
    await insertSource(state.testDb, { id: "src-slow", kind: "ats", persona: "remote" });

    const [userB] = await state.testDb
      .insert(users)
      .values({ email: "user-b-search-mutex@example.com", passwordHash: "h", role: "user" })
      .returning();
    await insertProfile(state.testDb, { id: "profile-b", userId: userB.id });
    await insertResume(state.testDb, { ...resumeFixture, userId: userB.id, isActive: true });

    // A starts a slow (never-completing-in-time) run for "remote" — reserves
    // A's persona slot.
    await startSearch(
      BOOTSTRAP_ADMIN_ID,
      { persona: "remote" },
      { connectorForSource: (s) => stubConnector(s, "hang-until-aborted"), hardRunTimeoutMs: 200 },
    );

    // B starting a run for the SAME persona must NOT see A's active run.
    const bRun = await startSearch(
      userB.id,
      { persona: "remote" },
      { connectorForSource: (s) => stubConnector(s, "hang-until-aborted"), hardRunTimeoutMs: 200 },
    );
    expect(bRun.status).toBe("queued");

    const bFinal = await waitForTerminal(runsRepo, bRun.id);
    expect(bFinal.userId).toBe(userB.id);
  });

  it("hard runtime cap: aborts an unresponsive connector, records it as a per-source error, and still completes", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    await insertSource(state.testDb, { id: "src-hangs", kind: "ats", persona: "remote" });

    const run = await startSearch(BOOTSTRAP_ADMIN_ID, 
      { persona: "remote" },
      {
        hardRunTimeoutMs: 20,
        connectorTimeoutMs: 60_000,
        connectorForSource: (source) => stubConnector(source, "hang-until-aborted"),
      },
    );

    const finalRow = await waitForTerminal(runsRepo, run.id);
    expect(finalRow.status).toBe("completed");
    expect(finalRow.stats.perSource).toEqual([{ sourceId: "src-hangs", found: 0, errors: 1 }]);
  });

  it("hard runtime cap covers scoring: a hung LLM call is aborted, the run still completes and releases its persona slot", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });

    const posting: RawPosting = {
      sourceId: good.id,
      url: "https://example.com/jobs/hang",
      title: "Data Engineer",
      company: "Acme",
      location: "Remote",
      description: "Build data pipelines with SQL.",
    };

    // Discovery finishes instantly (array stub); scoring then hangs in the
    // first LLM call (jd-extract). The 100ms hard cap must fire DURING scoring
    // — impossible under the pre-M0 code, which cleared the timer after
    // discovery — abort the LLM call, and let the run complete (0 scored).
    const run = await startSearch(BOOTSTRAP_ADMIN_ID,
      { persona: "remote" },
      { llm: hangingLlm, hardRunTimeoutMs: 100, connectorForSource: (source) => stubConnector(source, [posting]) },
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
    const postings: RawPosting[] = [
      { sourceId: good.id, url: "https://example.com/jobs/drain-1", title: "Data Engineer", company: "Acme", location: "Remote", description: "Build data pipelines with SQL." },
      { sourceId: good.id, url: "https://example.com/jobs/drain-2", title: "Data Engineer", company: "Beta Corp", location: "Remote", description: "Build more data pipelines with SQL." },
    ];

    const run = await startSearch(BOOTSTRAP_ADMIN_ID,
      { persona: "remote" },
      { llm: countingHangingLlm, scoreConcurrency: 1, hardRunTimeoutMs: 100, connectorForSource: (source) => stubConnector(source, postings) },
    );

    const finalRow = await waitForTerminal(runsRepo, run.id);
    expect(finalRow.status).toBe("completed");
    expect(finalRow.stats.scored).toBe(0);
    expect(hangingLlmCalls).toBe(1); // candidate 2 bailed at slot open, never reached the LLM
  });

  it("alias-merge preserves a previously-recorded cross-source alias across separate runs (regression)", async () => {
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const ats = await insertSource(state.testDb, { id: "src-ats", kind: "ats", persona: "remote" });
    const board = await insertSource(state.testDb, { id: "src-board", kind: "board", persona: "remote", config: { country: "MY" } });
    const runsRepo = createSearchRunsRepo(state.testDb);

    const atsPosting: RawPosting = {
      sourceId: ats.id,
      url: "https://ats.example.com/jobs/data-engineer",
      title: "Data Engineer",
      company: "Acme",
      location: "Remote",
    };
    const boardPosting: RawPosting = {
      sourceId: board.id,
      url: "https://board.example.com/jobs/data-engineer",
      title: "Data Engineer",
      company: "Acme",
      location: "Remote",
    };

    let boardYields: RawPosting[] = [];
    const deps = {
      llm: testLlm,
      connectorForSource: (source: SourceRow) =>
        source.id === "src-ats" ? stubConnector(source, [atsPosting]) : stubConnector(source, boardYields),
    };

    // Run 1 — only the ATS posting is found.
    const run1 = await startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote" }, deps);
    await waitForTerminal(runsRepo, run1.id);

    const dedupeKey = "ats.example.com/jobs/data-engineer";
    const afterRun1 = await findJobByDedupeKey(state.testDb, dedupeKey);
    expect(afterRun1?.aliases).toEqual([]);

    // Run 2 — the board also finds it now (same secondaryKey, different URL)
    // → its URL is appended as an alias (ATS stays canonical).
    boardYields = [boardPosting];
    const run2 = await startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote" }, deps);
    await waitForTerminal(runsRepo, run2.id);

    const afterRun2 = await findJobByDedupeKey(state.testDb, dedupeKey);
    expect(afterRun2?.aliases).toEqual([{ sourceId: "src-board", url: boardPosting.url }]);

    // Run 3 — the board doesn't come up this time; the alias it contributed
    // in run 2 must NOT be wiped (task-B5-brief.md alias-merge requirement).
    boardYields = [];
    const run3 = await startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote" }, deps);
    await waitForTerminal(runsRepo, run3.id);

    const afterRun3 = await findJobByDedupeKey(state.testDb, dedupeKey);
    expect(afterRun3?.aliases).toEqual([{ sourceId: "src-board", url: boardPosting.url }]);
  });

  it("B6 integration: scores top-N candidates and streams ordered progress(score/legitimacy)…job…done SSE, with stats.worth/ghosts populated", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });

    const posting: RawPosting = {
      sourceId: good.id,
      url: "https://example.com/jobs/integration",
      title: "Data Engineer",
      company: "Acme",
      location: "Remote",
      description: "Build data pipelines with SQL.",
    };

    const runPromise = startSearch(BOOTSTRAP_ADMIN_ID, 
      { persona: "remote" },
      { llm: testLlm, connectorForSource: (source) => stubConnector(source, [posting]) },
    );
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
    // Finding 3: candidates-exhausted, not cap-stopped — distinct from the
    // dedicated daily-cap test below, which asserts `capStopped: true`.
    expect(finalRow.stats.capStopped).toBe(false);

    const order = events.map((e) => e.event);
    // progress(sources) ... progress(fetch) ... progress(score)×k ... job ... progress(legitimacy) ... done
    expect(order[0]).toBe("progress");
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

  it("emits source + jobPhase deltas and leaves a coherent final frame (M2)", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });
    const posting: RawPosting = {
      sourceId: good.id,
      url: "https://example.com/jobs/a",
      title: "Data Engineer",
      company: "Acme",
      location: "Remote",
      description: "Build data pipelines with SQL.",
    };

    const runPromise = startSearch(BOOTSTRAP_ADMIN_ID,
      { persona: "remote" },
      { llm: costingLlm, connectorForSource: (s) => stubConnector(s, [posting]) },
    );
    // Registry lets a test grab the handle synchronously via the reserved
    // persona slot (same pattern as the B6 integration test above) — no
    // test-only onHandle seam needed.
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

    // Final frame is absolute + coherent: the source settled 'done', the
    // scored job left the active set, and the counts add up.
    const frame = ScanFrame.parse(handle.frame);
    expect(frame.sources).toEqual([{ sourceId: "src-good", name: "Test Source", status: "done", found: 1 }]);
    expect(frame.activeJobs).toEqual([]);
    expect(frame.counts).toEqual({ scored: 1, queued: 0, total: 1 });
  });

  it("daily cost cap: per-job gate stops scoring once dailyCapUsd is crossed (rolling pool, single slot), still completes", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });

    // Four matching candidates (distinct companies → 4 separate jobs).
    // costingLlm charges 0.02/job (0.01 jd-extract + 0.01 match-score).
    // scoreConcurrency:1 makes the rolling pool strictly sequential, so the
    // per-slot cap gate is deterministic: job1 (spent 0→0.02) and job2
    // (0.02→0.04) both open under the 0.025 cap and score, but job3's gate
    // sees 0.04 >= 0.025 and bails, as does job4 → 2 scored. The old batched
    // loop only checked BETWEEN batches of 3, so it scored all 3 of batch 1;
    // this asserts the per-job gate the rolling pool restores.
    const postings: RawPosting[] = [
      { sourceId: good.id, url: "https://example.com/jobs/cap-1", title: "Data Engineer", company: "Acme", location: "Remote", description: "Build data pipelines with SQL." },
      { sourceId: good.id, url: "https://example.com/jobs/cap-2", title: "Data Engineer", company: "Beta Corp", location: "Remote", description: "Build more data pipelines with SQL." },
      { sourceId: good.id, url: "https://example.com/jobs/cap-3", title: "Data Engineer", company: "Gamma Corp", location: "Remote", description: "Build even more data pipelines with SQL." },
      { sourceId: good.id, url: "https://example.com/jobs/cap-4", title: "Data Engineer", company: "Delta Corp", location: "Remote", description: "Build data pipelines yet again with SQL." },
    ];

    const run = await startSearch(BOOTSTRAP_ADMIN_ID,
      { persona: "remote" },
      { llm: costingLlm, dailyCapUsd: 0.025, scoreConcurrency: 1, connectorForSource: (source) => stubConnector(source, postings) },
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

    // 3 candidates through the rolling pool: 2 with a description score
    // normally via testLlm; the 3rd has no description and the stub
    // connector has no fetchDetail, so ensureDescription leaves it null and
    // scoreJob throws EmptyJobDescriptionError -> counted unscored, not a
    // tolerated failure.
    const postings: RawPosting[] = [
      { sourceId: good.id, url: "https://example.com/jobs/mix-1", title: "Data Engineer", company: "Acme", location: "Remote", description: "Build data pipelines with SQL." },
      { sourceId: good.id, url: "https://example.com/jobs/mix-2", title: "Data Engineer", company: "Beta Corp", location: "Remote", description: "Build more data pipelines with SQL." },
      { sourceId: good.id, url: "https://example.com/jobs/mix-3", title: "Data Engineer", company: "Gamma Corp", location: "Remote" },
    ];

    const run = await startSearch(BOOTSTRAP_ADMIN_ID, 
      { persona: "remote" },
      { llm: testLlm, connectorForSource: (source) => stubConnector(source, postings) },
    );

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
    const postings: RawPosting[] = [
      { sourceId: good.id, url: "https://example.com/jobs/a", title: "Data Engineer", company: "Acme", location: "Remote", description: "Build data pipelines with SQL." },
      { sourceId: good.id, url: "https://example.com/jobs/b", title: "Data Engineer", company: "Beta", location: "Remote", description: "More SQL pipelines." },
    ];
    const run = await startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote" }, { llm: costingLlm, connectorForSource: (s) => stubConnector(s, postings) });
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
    const postings: RawPosting[] = [
      { sourceId: good.id, url: "https://example.com/jobs/a", title: "Data Engineer", company: "Acme", location: "Remote", description: "Build data pipelines with SQL." },
    ];
    // scoreOnceThenThrow: first job scores, then the repo write path is poisoned to force runFanOut into failRun.
    const run = await startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote" }, { llm: costingLlm, connectorForSource: (s) => stubConnector(s, postings), afterScoring: () => { throw new Error("boom"); } });
    const finalRow = await waitForTerminal(runsRepo, run.id);

    expect(finalRow.status).toBe("failed");
    expect(finalRow.error).toContain("boom");
    expect(finalRow.results).toHaveLength(1);           // the job that settled before the crash
    expect(finalRow.stats.scored).toBe(1);              // accumulated, not zeroed
  });

  it("cap-hit run persists skipped:dailyCap result rows for the un-scored top candidates", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });
    const postings: RawPosting[] = [1, 2, 3, 4].map((n) => ({
      sourceId: good.id, url: `https://example.com/jobs/cap-${n}`, title: "Data Engineer",
      company: `Co${n}`, location: "Remote", description: "Build data pipelines with SQL.",
    }));
    const run = await startSearch(BOOTSTRAP_ADMIN_ID, { persona: "remote" },
      { llm: costingLlm, dailyCapUsd: 0.025, scoreConcurrency: 1, connectorForSource: (s) => stubConnector(s, postings) });
    const finalRow = await waitForTerminal(runsRepo, run.id);

    expect(finalRow.status).toBe("completed");
    expect(finalRow.stats.capStopped).toBe(true);
    const scored = finalRow.results.filter((r) => r.outcome === "scored");
    const skipped = finalRow.results.filter((r) => r.outcome === "skipped" && r.reason === "dailyCap");
    expect(scored).toHaveLength(2);
    expect(skipped).toHaveLength(2); // the 2 candidates the gate bailed on are recorded, not dropped
  });
});
