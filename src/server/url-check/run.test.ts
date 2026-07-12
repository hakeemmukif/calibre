import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { LlmClient } from "@/lib/llm/client";
import { makeMockLlm } from "@/lib/llm/mock";
import { insertProfile, insertResume, insertSource, insertJob } from "@/server/persistence/repos/__fixtures__/helpers";
import { createJobsRepo } from "@/server/persistence/repos/jobs";
import { createUrlChecksRepo, type UrlCheckRow } from "@/server/persistence/repos/urlChecks";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";

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

  it("dedupe short-circuit: existing job -> 200-shaped alreadyKnown, no LLM call, no pipeline started", async () => {
    const db = await createTestDb();
    state.testDb = db;
    await insertResume(db, { isActive: true });
    const source = await insertSource(db);
    const existing = await insertJob(db, source.id, {
      dedupeKey: "example.com/already-known",
      url: "https://example.com/already-known",
    });
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
});
