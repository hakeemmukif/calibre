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

// Scoring is wired into the run (B6) — every startSearch() call that
// actually upserts a matched job reaches scoreTopCandidates, which needs an
// LlmClient. No network in tests: a scripted mock covering both stages.
const testLlm = makeMockLlm({
  "jd-extract": {
    title: "Data Engineer",
    mustHaves: ["SQL"],
    niceToHaves: [],
    responsibilities: ["Build pipelines"],
    redFlags: [],
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
          mustHaves: ["SQL"],
          niceToHaves: [],
          responsibilities: ["Build pipelines"],
          redFlags: [],
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
    name: "Jane Doe",
    contact: [{ label: "email", value: "jane@example.com" }],
    summary: "Backend engineer.",
    experience: [{ company: "Old Co", title: "Senior Data Engineer", dates: "2020-Present", bullets: [] }],
    education: [],
    skills: [{ label: "Languages", items: ["TypeScript"] }],
    extras: [],
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
    // Every test shares one PGlite instance (beforeAll) — without this, a
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

  it("daily cost cap: stops scoring early once dailyCapUsd is reached BETWEEN batches, still completes (finding 3 + task-7b batching)", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });

    // Four matching candidates, distinct company (so dedupe.ts secondaryKey
    // keeps them as 4 separate jobs) — SCORE_BATCH_SIZE (3) puts the first 3
    // in batch 1 and the 4th alone in batch 2. costingLlm charges 0.02/job;
    // cap 0.025 is BELOW even a single job's running total after job 2
    // (0.04), so a per-job check (pre-batching behaviour) would have stopped
    // mid-batch after 2 jobs — but the cap is only checked BETWEEN batches
    // now, so batch 1 runs to completion (all 3, spentToday -> 0.06) before
    // the pre-batch-2 check sees 0.06 >= 0.025 and stops; the 4th candidate
    // is never attempted.
    const postings: RawPosting[] = [
      { sourceId: good.id, url: "https://example.com/jobs/cap-1", title: "Data Engineer", company: "Acme", location: "Remote", description: "Build data pipelines with SQL." },
      { sourceId: good.id, url: "https://example.com/jobs/cap-2", title: "Data Engineer", company: "Beta Corp", location: "Remote", description: "Build more data pipelines with SQL." },
      { sourceId: good.id, url: "https://example.com/jobs/cap-3", title: "Data Engineer", company: "Gamma Corp", location: "Remote", description: "Build even more data pipelines with SQL." },
      { sourceId: good.id, url: "https://example.com/jobs/cap-4", title: "Data Engineer", company: "Delta Corp", location: "Remote", description: "Build data pipelines yet again with SQL." },
    ];

    const run = await startSearch(BOOTSTRAP_ADMIN_ID, 
      { persona: "remote" },
      {
        llm: costingLlm,
        dailyCapUsd: 0.025,
        connectorForSource: (source) => stubConnector(source, postings),
      },
    );

    const finalRow = await waitForTerminal(runsRepo, run.id);

    expect(finalRow.status).toBe("completed");
    expect(finalRow.stats.matched).toBe(4);
    expect(finalRow.stats.scored).toBe(3); // all of batch 1 — proves the cap wasn't enforced mid-batch
    expect(finalRow.stats.capStopped).toBe(true);
  });

  it("batched scoring: all candidates in a single batch are scored, aggregating stats across a mix of successes and EmptyJobDescriptionError (task-7b)", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });

    // 3 candidates (one SCORE_BATCH_SIZE batch): 2 with a description score
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
});
