import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { insertProfile, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import type { SourceRow } from "@/server/persistence/repos/sources";
import { jobs, resumes, searchRuns, sources, users } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import type { RawPosting, SourceConnector } from "@/server/search/connector";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";
import { UnauthorizedError } from "@/server/auth/errors";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb, hang: false }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { requireUser } = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/server/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/server/auth/session")>()),
  requireUser: () => requireUser(),
}));

function stubConnector(source: SourceRow): SourceConnector {
  return {
    id: source.id,
    kind: source.kind,
    persona: source.persona,
    async *discover(ctx) {
      const postings: RawPosting[] = [];
      if (state.hang) {
        // Check the already-aborted case explicitly — an 'abort' listener
        // added after the signal already fired never triggers.
        if (ctx.signal.aborted) throw new Error("aborted");
        await new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      for (const p of postings) yield p;
    },
  };
}
vi.mock("@/server/search/connectors", () => ({ connectorForSource: (source: SourceRow) => stubConnector(source) }));

const { POST } = await import("./route");
const { __resetForTests, get: getRunHandle } = await import("@/server/runs/registry");

async function waitForTerminal(id: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await state.testDb.select().from(searchRuns).where(eq(searchRuns.id, id)).limit(1);
    if (row && (row.status === "completed" || row.status === "failed")) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`run ${id} did not reach a terminal state within the test timeout`);
}

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/search", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
    await insertProfile(state.testDb); // startSearch requires the operator profile (spec §4)
  });

  beforeEach(() => {
    requireUser.mockReset();
    requireUser.mockResolvedValue({ id: BOOTSTRAP_ADMIN_ID, email: "admin@example.com", role: "admin" });
  });

  afterEach(async () => {
    state.hang = false;
    __resetForTests();
    await state.testDb.delete(jobs);
    await state.testDb.delete(searchRuns);
    await state.testDb.delete(sources);
    await state.testDb.delete(resumes);
  });

  it("401s with UNAUTHORIZED when there is no session", async () => {
    requireUser.mockRejectedValue(new UnauthorizedError());
    const res = await POST(jsonRequest({ persona: "remote" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("empty sources[] returns 422 VALIDATION_ERROR (not a silent 'use all')", async () => {
    const res = await POST(jsonRequest({ persona: "remote", sources: [] }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("sources naming an unknown/disabled source id returns 422 VALIDATION_ERROR with details.unknownSourceIds", async () => {
    await insertResume(state.testDb, { isActive: true });
    await insertSource(state.testDb, { id: "greenhouse", kind: "ats", persona: "remote" });

    const res = await POST(jsonRequest({ persona: "remote", sources: ["greenhouse", "typo-id"] }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details.unknownSourceIds).toEqual(["typo-id"]);
  });

  it("no résumé returns 409 CONFLICT", async () => {
    await insertSource(state.testDb, { id: "greenhouse", kind: "ats", persona: "remote" });
    const res = await POST(jsonRequest({ persona: "remote" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
  });

  it("happy path returns 202 with a queued SearchRun", async () => {
    await insertResume(state.testDb, { isActive: true });
    await insertSource(state.testDb, { id: "greenhouse", kind: "ats", persona: "remote" });

    const res = await POST(jsonRequest({ persona: "remote" }));
    expect(res.status).toBe(202);
    const run = await res.json();
    expect(run.status).toBe("queued");
    expect(run.persona).toBe("remote");

    await waitForTerminal(run.id);
  });

  it("a run already active for the persona returns 409 CONFLICT with details.activeRunId", async () => {
    await insertResume(state.testDb, { isActive: true });
    await insertSource(state.testDb, { id: "greenhouse", kind: "ats", persona: "remote" });
    state.hang = true;

    const first = await POST(jsonRequest({ persona: "remote" }));
    expect(first.status).toBe(202);
    const firstRun = await first.json();

    const second = await POST(jsonRequest({ persona: "remote" }));
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.details.activeRunId).toBe(firstRun.id);

    // Let the still-"running" first run settle before the next test's
    // afterEach truncates the tables out from under it.
    getRunHandle(firstRun.id)?.abort("test cleanup");
    await waitForTerminal(firstRun.id);
  });

  it("the 409 active-run mutex is per-user — A's active run for a persona does NOT block B (Fable design review)", async () => {
    await insertResume(state.testDb, { isActive: true });
    await insertSource(state.testDb, { id: "greenhouse", kind: "ats", persona: "remote" });
    state.hang = true;

    const [userB] = await state.testDb
      .insert(users)
      .values({ email: "user-b-search-mutex-route@example.com", passwordHash: "h", role: "user" })
      .returning();
    await insertProfile(state.testDb, { id: "profile-b-route", userId: userB.id });
    await insertResume(state.testDb, { userId: userB.id, isActive: true });

    const first = await POST(jsonRequest({ persona: "remote" }));
    expect(first.status).toBe(202);
    const firstRun = await first.json();

    requireUser.mockResolvedValue({ id: userB.id, email: userB.email, role: "user" });
    const second = await POST(jsonRequest({ persona: "remote" }));
    expect(second.status).toBe(202);
    const secondRun = await second.json();
    expect(secondRun.id).not.toBe(firstRun.id);

    getRunHandle(firstRun.id)?.abort("test cleanup");
    getRunHandle(secondRun.id)?.abort("test cleanup");
    await waitForTerminal(firstRun.id);
    await waitForTerminal(secondRun.id);
  });

  it("invalid JSON body returns 422 VALIDATION_ERROR", async () => {
    const req = new NextRequest("http://localhost/api/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("missing persona returns 422 VALIDATION_ERROR", async () => {
    const res = await POST(jsonRequest({}));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("persona 'pasted' returns 422 VALIDATION_ERROR (scan-only boundary — spec §11.2)", async () => {
    const res = await POST(jsonRequest({ persona: "pasted" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });
});
