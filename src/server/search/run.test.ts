import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { createSearchRunsRepo, type SearchRunRow } from "@/server/persistence/repos/searchRuns";
import { jobs, resumes, searchRuns, sources } from "@/server/persistence/schema";
import type { SourceRow } from "@/server/persistence/repos/sources";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import type { RawPosting, SourceConnector } from "./connector";

async function findJobByDedupeKey(db: TestDb, dedupeKey: string) {
  const [row] = await db.select().from(jobs).where(eq(jobs.dedupeKey, dedupeKey)).limit(1);
  return row;
}

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

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

async function waitForTerminal(repo: ReturnType<typeof createSearchRunsRepo>, id: string): Promise<SearchRunRow> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const row = await repo.getById(id);
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
  });

  afterEach(async () => {
    __resetForTests();
    // Every test shares one PGlite instance (beforeAll) — without this, a
    // later test's listEnabledByPersona("remote") would also see earlier
    // tests' source rows.
    await state.testDb.delete(jobs);
    await state.testDb.delete(searchRuns);
    await state.testDb.delete(sources);
    await state.testDb.delete(resumes);
  });

  it("returns a queued SearchRun immediately, then completes: upserts matched jobs, records stats.perSource incl. a partial failure", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });

    const good = await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });
    await insertSource(state.testDb, { id: "src-bad", kind: "board", persona: "remote" });

    const matching: RawPosting = {
      sourceId: good.id,
      url: "https://example.com/jobs/1",
      title: "Data Engineer",
      company: "Acme",
      location: "Remote",
    };
    const nonMatching: RawPosting = {
      sourceId: good.id,
      url: "https://example.com/jobs/2",
      title: "Product Designer",
      company: "Acme",
      location: "Remote",
    };

    const run = await startSearch(
      { persona: "remote" },
      {
        concurrency: 5,
        connectorTimeoutMs: 500,
        hardRunTimeoutMs: 3000,
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

  it("throws NoActiveResumeError when no résumé exists", async () => {
    const originalDb = state.testDb;
    state.testDb = await createTestDb(); // fresh, résumé-less DB
    await expect(startSearch({ persona: "remote" })).rejects.toThrow(NoActiveResumeError);
    state.testDb = originalDb;
  });

  it("throws UnknownSourceIdsError naming the unknown ids when sources includes an id outside the persona's enabled set", async () => {
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    await insertSource(state.testDb, { id: "src-good", kind: "ats", persona: "remote" });

    let caught: unknown;
    try {
      await startSearch({ persona: "remote", sources: ["src-good", "typo-id"] });
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

    const runPromise = startSearch(
      { persona: "remote" },
      { connectorForSource: (source) => stubConnector(source, []) },
    );
    // Subscribe via the synchronously-reserved persona slot (finding 4's
    // fix) before awaiting — guarantees we're listening before the crash,
    // which only happens after an internal DB await resolves.
    const reservedId = getActiveRunForPersona("remote")!;
    const handle = getRunHandle(reservedId)!;
    const events: string[] = [];
    handle.subscribe((event) => events.push(event.event));

    const run = await runPromise;
    expect(run.id).toBe(reservedId);

    const finalRow = await waitForTerminal(runsRepo, run.id);
    expect(finalRow.status).toBe("failed");
    expect(finalRow.error).toBeTruthy();
    expect(events).toContain("error");
    expect(getActiveRunForPersona("remote")).toBeUndefined();
  });

  it("throws ActiveRunConflictError with the running run's id when a run is already active for that persona", async () => {
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    await insertSource(state.testDb, { id: "src-slow", kind: "ats", persona: "remote" });

    const first = await startSearch(
      { persona: "remote" },
      { connectorForSource: (s) => stubConnector(s, "hang-until-aborted"), hardRunTimeoutMs: 200 },
    );

    let caught: unknown;
    try {
      await startSearch({ persona: "remote" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ActiveRunConflictError);
    expect((caught as InstanceType<typeof ActiveRunConflictError>).activeRunId).toBe(first.id);
  });

  it("hard runtime cap: aborts an unresponsive connector, records it as a per-source error, and still completes", async () => {
    const runsRepo = createSearchRunsRepo(state.testDb);
    await insertResume(state.testDb, { ...resumeFixture, isActive: true });
    await insertSource(state.testDb, { id: "src-hangs", kind: "ats", persona: "remote" });

    const run = await startSearch(
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
    const board = await insertSource(state.testDb, { id: "src-board", kind: "board", persona: "remote" });
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
      connectorForSource: (source: SourceRow) =>
        source.id === "src-ats" ? stubConnector(source, [atsPosting]) : stubConnector(source, boardYields),
    };

    // Run 1 — only the ATS posting is found.
    const run1 = await startSearch({ persona: "remote" }, deps);
    await waitForTerminal(runsRepo, run1.id);

    const dedupeKey = "ats.example.com/jobs/data-engineer";
    const afterRun1 = await findJobByDedupeKey(state.testDb, dedupeKey);
    expect(afterRun1?.aliases).toEqual([]);

    // Run 2 — the board also finds it now (same secondaryKey, different URL)
    // → its URL is appended as an alias (ATS stays canonical).
    boardYields = [boardPosting];
    const run2 = await startSearch({ persona: "remote" }, deps);
    await waitForTerminal(runsRepo, run2.id);

    const afterRun2 = await findJobByDedupeKey(state.testDb, dedupeKey);
    expect(afterRun2?.aliases).toEqual([{ sourceId: "src-board", url: boardPosting.url }]);

    // Run 3 — the board doesn't come up this time; the alias it contributed
    // in run 2 must NOT be wiped (task-B5-brief.md alias-merge requirement).
    boardYields = [];
    const run3 = await startSearch({ persona: "remote" }, deps);
    await waitForTerminal(runsRepo, run3.id);

    const afterRun3 = await findJobByDedupeKey(state.testDb, dedupeKey);
    expect(afterRun3?.aliases).toEqual([{ sourceId: "src-board", url: boardPosting.url }]);
  });
});
