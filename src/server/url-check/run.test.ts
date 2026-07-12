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
