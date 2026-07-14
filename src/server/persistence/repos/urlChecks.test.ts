import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { urlChecks } from "../schema";
import { createTestDb } from "../test-db";
import { insertJob, insertSource } from "./__fixtures__/helpers";
import { createUrlChecksRepo } from "./urlChecks";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

describe("urlChecksRepo", () => {
  it("round-trips insert/getById", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);

    const inserted = await repo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      url: "https://boards.greenhouse.io/example/jobs/123",
      dedupeKey: "greenhouse.io/example/jobs/123",
      status: "queued",
      alreadyKnown: false,
      needsText: false,
      costUsd: 0,
      raw: { pastedText: null },
    });
    expect(inserted.status).toBe("queued");
    expect(inserted.jobId).toBeNull();
    expect(inserted.finishedAt).toBeNull();

    const fetched = await repo.getById(inserted.id);
    expect(fetched?.id).toBe(inserted.id);
    expect(await repo.getById("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("updateStage sets stage without touching status", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);
    const inserted = await repo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      url: "https://x.example/job", dedupeKey: "x.example/job", status: "running",
      alreadyKnown: false, needsText: false, costUsd: 0, raw: {},
    });

    const staged = await repo.updateStage(inserted.id, "fetching", 0);
    expect(staged?.stage).toBe("fetching");
    expect(staged?.status).toBe("running");
  });

  it("complete sets status completed, jobId, alreadyKnown, finishedAt", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);
    const source = await insertSource(db);
    const job = await insertJob(db, source.id);
    const inserted = await repo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      url: "https://x.example/job", dedupeKey: "x.example/job", status: "running",
      alreadyKnown: false, needsText: false, costUsd: 0, raw: {},
    });

    const done = await repo.complete(inserted.id, { jobId: job.id, alreadyKnown: true }, 0);
    expect(done?.status).toBe("completed");
    expect(done?.jobId).toBe(job.id);
    expect(done?.alreadyKnown).toBe(true);
    expect(done?.finishedAt).not.toBeNull();
  });

  it("fail sets status failed, error, needsText, finishedAt", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);
    const inserted = await repo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      url: "https://x.example/job", dedupeKey: "x.example/job", status: "running",
      alreadyKnown: false, needsText: false, costUsd: 0, raw: {},
    });

    const failed = await repo.fail(inserted.id, {
      code: "NOT_A_JOB_POSTING", message: "page is not a job posting", needsText: true,
    }, 0);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toEqual({ code: "NOT_A_JOB_POSTING", message: "page is not a job posting" });
    expect(failed?.needsText).toBe(true);
    expect(failed?.finishedAt).not.toBeNull();
  });

  it("addCost accumulates costUsd across multiple calls", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);
    const inserted = await repo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      url: "https://x.example/job", dedupeKey: "x.example/job", status: "running",
      alreadyKnown: false, needsText: false, costUsd: 0, raw: {},
    });

    await repo.addCost(inserted.id, 0.01, 0);
    const after = await repo.addCost(inserted.id, 0.005, 0);
    expect(after?.costUsd).toBeCloseTo(0.015, 6);
  });
});

function queuedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    userId: BOOTSTRAP_ADMIN_ID,
    url: "https://example.com/job",
    dedupeKey: "example.com/job",
    status: "queued" as const,
    stage: null,
    jobId: null,
    alreadyKnown: false,
    needsText: false,
    error: null,
    costUsd: 0,
    raw: { text: null },
    ...overrides,
  };
}

describe("url_checks schema", () => {
  it("defaults attempts to 0 and leaseExpiresAt to null on insert", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);
    const row = await repo.insert(queuedRow());
    expect(row.attempts).toBe(0);
    expect(row.leaseExpiresAt).toBeNull();
  });
});

describe("claimNextQueued", () => {
  it("flips the oldest queued row to running, sets attempts=1 and a future lease", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);
    const first = await repo.insert(queuedRow());
    await repo.insert(queuedRow());

    const claimed = await repo.claimNextQueued();

    expect(claimed?.id).toBe(first.id); // ORDER BY created_at
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.leaseExpiresAt).not.toBeNull();
    expect(claimed!.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("returns null when nothing is queued", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);
    expect(await repo.claimNextQueued()).toBeNull();
  });

  it("two sequential claims return two distinct rows", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);
    await repo.insert(queuedRow());
    await repo.insert(queuedRow());
    const a = await repo.claimNextQueued();
    const b = await repo.claimNextQueued();
    expect(a?.id).not.toBe(b?.id);
    expect(await repo.claimNextQueued()).toBeNull();
  });
});

describe("requeueOrphanedRunning", () => {
  it("requeues running rows under the attempt cap and fails those at/over it", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);
    const young = await repo.insert(queuedRow({ status: "running", attempts: 1, stage: "scoring" }));
    const old = await repo.insert(queuedRow({ status: "running", attempts: 2 }));
    const queued = await repo.insert(queuedRow()); // untouched

    const result = await repo.requeueOrphanedRunning();

    expect(result).toEqual({ requeued: 1, failed: 1 });
    expect((await repo.getById(young.id))?.status).toBe("queued");
    expect((await repo.getById(young.id))?.stage).toBeNull();
    expect((await repo.getById(old.id))?.status).toBe("failed");
    expect((await repo.getById(queued.id))?.status).toBe("queued");
  });
});

describe("sweepExpiredLeases", () => {
  // Drive lease timestamps with SQL intervals (the Postgres time frame), NOT
  // JS Dates: `lease_expires_at` is a tz-naive `timestamp`, so a JS Date
  // round-trips shifted by the local UTC offset (deferred TZ bug, spec §8 #3).
  // Production is unaffected — claimNextQueued writes `now()+interval` and this
  // sweep compares `< now()`, both server-side.
  it("requeues an expired-lease row under the cap, fails it at the cap, leaves a future lease alone", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);
    const setLease = (id: string, expr: ReturnType<typeof sql>) =>
      db.update(urlChecks).set({ leaseExpiresAt: expr }).where(eq(urlChecks.id, id));
    const requeue = await repo.insert(queuedRow({ status: "running", attempts: 1, stage: "scoring" }));
    const fail = await repo.insert(queuedRow({ status: "running", attempts: 2 }));
    const healthy = await repo.insert(queuedRow({ status: "running", attempts: 1 }));
    await setLease(requeue.id, sql`now() - interval '1 minute'`);
    await setLease(fail.id, sql`now() - interval '1 minute'`);
    await setLease(healthy.id, sql`now() + interval '10 minutes'`);

    const result = await repo.sweepExpiredLeases();

    expect(result).toEqual({ requeued: 1, failed: 1 });
    expect((await repo.getById(requeue.id))?.status).toBe("queued");
    expect((await repo.getById(requeue.id))?.stage).toBeNull();
    expect((await repo.getById(fail.id))?.status).toBe("failed");
    expect((await repo.getById(healthy.id))?.status).toBe("running"); // future lease untouched
  });
});

describe("listActive / listByIds", () => {
  it("listActive returns queued+running only, oldest first", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);
    await repo.insert(queuedRow({ status: "completed" }));
    const q = await repo.insert(queuedRow());
    const r = await repo.insert(queuedRow({ status: "running", attempts: 1 }));
    const active = await repo.listActive();
    expect(active.map((x) => x.id).sort()).toEqual([q.id, r.id].sort());
  });

  it("listByIds returns exact rows regardless of status; [] for empty input", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);
    const a = await repo.insert(queuedRow({ status: "completed" }));
    const b = await repo.insert(queuedRow({ status: "failed" }));
    await repo.insert(queuedRow());
    expect((await repo.listByIds([a.id, b.id])).map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(await repo.listByIds([])).toEqual([]);
  });
});

describe("attempt-fenced writes", () => {
  it("a stale-attempt complete()/fail()/updateStage() no-ops against a row held by a newer attempt", async () => {
    const db = await createTestDb();
    const repo = createUrlChecksRepo(db);
    // Row currently owned by attempt 2.
    const row = await repo.insert(queuedRow({ status: "running", attempts: 2 }));

    expect(await repo.updateStage(row.id, "scoring", 1)).toBeNull(); // stale
    expect(await repo.complete(row.id, { jobId: null as unknown as string, alreadyKnown: true }, 1)).toBeNull();
    expect((await repo.getById(row.id))?.status).toBe("running"); // untouched

    expect(await repo.updateStage(row.id, "scoring", 2)).not.toBeNull(); // owner
    expect((await repo.getById(row.id))?.stage).toBe("scoring");
  });
});
