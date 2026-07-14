import { describe, expect, it, vi } from "vitest";
import { insertJob, insertJobScore, insertProfile, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { createUrlChecksRepo } from "@/server/persistence/repos/urlChecks";
import { users } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import type { UrlCheckRequest } from "@/types";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { createUrlCheckWorker } = await import("./worker");

function queued(db: TestDb, url: string, text: string | null) {
  return createUrlChecksRepo(db).insert({
    id: crypto.randomUUID(), userId: BOOTSTRAP_ADMIN_ID, url, dedupeKey: url, status: "queued", stage: null,
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
    expect((await createUrlChecksRepo(db).getById(row.id, BOOTSTRAP_ADMIN_ID))?.status).toBe("queued");
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
    expect(fakeRun).toHaveBeenCalledTimes(3);       // exactly concurrency, not more
    expect(maxActive).toBe(3);                       // genuinely ran 3 at once (not a 0 false-positive)
    const stillQueued = (await createUrlChecksRepo(db).listActive(BOOTSTRAP_ADMIN_ID)).filter((r) => r.status === "queued");
    expect(stillQueued).toHaveLength(3);             // drain did NOT over-claim the other 3
    gate.splice(0).forEach((release) => release());  // drain the held jobs
  });

  // The leak (Step 3 task 5): the claim-time re-check used to call
  // jobsRepo.getByDedupeKey(row.dedupeKey) / hasAnyScore(existingJob.id) with
  // no userId filter — so B's queued check for a URL A already scored would
  // resolve A's job and complete B's row as alreadyKnown pointing at A's
  // jobId (a cross-tenant leak, and a 404 in B's UI since jobsRepo.getById is
  // scoped to B). Scoping both calls to row.userId closes it: B's lookup
  // finds nothing under B's own userId, so the row falls through to the
  // normal pipeline instead of short-circuiting onto A's job.
  it("cross-tenant dedupe: B's queued check for a URL A already scored does NOT complete alreadyKnown pointing at A's job", async () => {
    const db = await createTestDb();
    state.testDb = db;
    const source = await insertSource(db);
    const resumeA = await insertResume(db, { isActive: true });
    const jobA = await insertJob(db, source.id, { url: "https://leak.example/x", dedupeKey: "leak.example/x" });
    await insertJobScore(db, jobA.id, resumeA.id);

    const [userB] = await db
      .insert(users)
      .values({ email: `user-b-worker-leak-${crypto.randomUUID()}@example.com`, passwordHash: "h", role: "user" })
      .returning();
    await insertResume(db, { isActive: true, userId: userB.id });
    await insertProfile(db, { id: `profile-b-worker-leak-${crypto.randomUUID()}`, userId: userB.id });
    const rowB = await createUrlChecksRepo(db).insert({
      id: crypto.randomUUID(),
      userId: userB.id,
      url: "https://leak.example/x",
      dedupeKey: "leak.example/x", // SAME dedupeKey as jobA — the collision the leak exploited
      status: "queued",
      stage: null,
      jobId: null,
      alreadyKnown: false,
      needsText: false,
      error: null,
      costUsd: 0,
      raw: { text: null },
    });

    const fakeRun = vi.fn(async (checkId: string, _req: unknown, ctx: { attempt: number }) => {
      await createUrlChecksRepo(db).fail(checkId, { code: "INTERNAL", message: "test-stop", needsText: false }, ctx.attempt);
    });
    const worker = createUrlCheckWorker({ runPipeline: fakeRun as never, llm: {} as never });

    await worker.drainOnce();

    // Proceeded to the real pipeline instead of short-circuiting — proof the
    // scoped dedupe lookup found nothing under B's own userId.
    expect(fakeRun).toHaveBeenCalledTimes(1);
    const finalRowB = await createUrlChecksRepo(db).getById(rowB.id, userB.id);
    expect(finalRowB?.alreadyKnown).toBe(false);
    expect(finalRowB?.jobId).not.toBe(jobA.id);
  });
});
