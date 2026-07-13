import { describe, expect, it, vi } from "vitest";
import { insertProfile, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { createUrlChecksRepo } from "@/server/persistence/repos/urlChecks";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import type { UrlCheckRequest } from "@/types";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { createUrlCheckWorker } = await import("./worker");

function queued(db: TestDb, url: string, text: string | null) {
  return createUrlChecksRepo(db).insert({
    id: crypto.randomUUID(), url, dedupeKey: url, status: "queued", stage: null,
    jobId: null, alreadyKnown: false, needsText: false, error: null, costUsd: 0, raw: { text },
  });
}

describe("url-check worker", () => {
  it("rehydrates a URL-mode row as text:undefined and a paste-mode row as its text", async () => {
    const db = await createTestDb();
    state.testDb = db;
    await insertSource(db);
    await insertResume(db, { isActive: true });
    await insertProfile(db);
    const seen: UrlCheckRequest[] = [];
    const fakeRun = vi.fn(async (checkId: string, req: UrlCheckRequest, ctx: { attempt: number }) => {
      seen.push(req);
      await createUrlChecksRepo(db).fail(checkId, { code: "INTERNAL", message: "test-stop", needsText: false }, ctx.attempt);
    });

    await queued(db, "https://a.com/url-mode", null);
    await queued(db, "https://b.com/paste-mode", "Acme is hiring a Staff Engineer.");
    const worker = createUrlCheckWorker({ runPipeline: fakeRun as never, llm: {} as never });

    await worker.drainOnce();
    await worker.drainOnce();

    expect(seen).toHaveLength(2);
    expect(seen[0].text).toBeUndefined();      // URL mode
    expect(seen[1].text).toBe("Acme is hiring a Staff Engineer.");
  });

  it("pause-on-cap leaves the queued row queued and reports isPaused()", async () => {
    const db = await createTestDb();
    state.testDb = db;
    const row = await queued(db, "https://c.com/job", null);
    // dailyCapUsd 0 → spentToday (0) >= 0 → always capped.
    const worker = createUrlCheckWorker({ dailyCapUsd: 0, runPipeline: vi.fn() as never });

    const claimed = await worker.drainOnce();

    expect(claimed).toBe(false);
    expect(worker.isPaused()).toBe(true);
    expect((await createUrlChecksRepo(db).getById(row.id))?.status).toBe("queued");
  });

  it("serialized drain never runs more pipelines than the concurrency limit", async () => {
    const db = await createTestDb();
    state.testDb = db;
    await insertSource(db);
    await insertResume(db, { isActive: true });
    await insertProfile(db);
    for (let i = 0; i < 6; i++) await queued(db, `https://d.com/job-${i}`, null);

    let active = 0;
    let maxActive = 0;
    const gate: Array<() => void> = [];
    const fakeRun = vi.fn(async (checkId: string, _req: unknown, ctx: { attempt: number }) => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => gate.push(resolve)); // hold the slot open
      active--;
      await createUrlChecksRepo(db).fail(checkId, { code: "INTERNAL", message: "done", needsText: false }, ctx.attempt);
    });
    const worker = createUrlCheckWorker({ concurrency: 3, runPipeline: fakeRun as never, llm: {} as never });

    await worker.kick();                              // fills 3 slots, then stops
    await new Promise((r) => setTimeout(r, 0));       // let p-limit promote pending→active
    expect(maxActive).toBeLessThanOrEqual(3);
    gate.splice(0).forEach((release) => release());   // drain the held jobs
  });
});
