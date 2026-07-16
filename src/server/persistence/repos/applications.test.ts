import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { applications, users } from "../schema";
import { createTestDb } from "../test-db";
import { insertJob, insertJobScore, insertResume, insertSource } from "./__fixtures__/helpers";
import { encodeCursorId } from "./cursor";
import { ApplicationConflictError, createApplicationsRepo } from "./applications";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

// Identical appliedAt across all rows — deterministic same-millisecond
// collision regardless of host/loop speed. Postgres's timestamp column
// stores microsecond precision, so the pg-era version of this test forced
// sub-ms-distinct-but-ms-identical values via a raw `::timestamp` cast;
// SQLite's timestamp_ms column only ever stores whole milliseconds, so a
// literal shared Date value already produces a true collision — no raw SQL
// cast needed.
const COLLIDING_TIMESTAMP = new Date("2024-01-01T00:00:00.100Z");

describe("applicationsRepo", () => {
  it("round-trips insertUniqueByJob", async () => {
    const db = await createTestDb();
    const repo = createApplicationsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);

    const app = await repo.insertUniqueByJob({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      resumeId: resume.id,
      stage: 0,
      statusLabel: "Applied",
      statusTone: "good",
      note: "",
    });

    expect(app.jobId).toBe(job.id);
    expect(app.stage).toBe(0);
  });

  it("throws ApplicationConflictError with the existing id on duplicate jobId", async () => {
    const db = await createTestDb();
    const repo = createApplicationsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);

    const first = await repo.insertUniqueByJob({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      resumeId: resume.id,
      stage: 0,
      statusLabel: "Applied",
      statusTone: "good",
      note: "",
    });

    await expect(
      repo.insertUniqueByJob({
        userId: BOOTSTRAP_ADMIN_ID,
        jobId: job.id,
        resumeId: resume.id,
        stage: 0,
        statusLabel: "Applied",
        statusTone: "good",
        note: "",
      }),
    ).rejects.toThrow(ApplicationConflictError);

    try {
      await repo.insertUniqueByJob({
        userId: BOOTSTRAP_ADMIN_ID,
        jobId: job.id,
        resumeId: resume.id,
        stage: 0,
        statusLabel: "Applied",
        statusTone: "good",
        note: "",
      });
      throw new Error("expected insertUniqueByJob to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ApplicationConflictError);
      expect((err as ApplicationConflictError).existingId).toBe(first.id);
    }
  });

  it("listJoined yields role/company/meta/score from the job+score join", async () => {
    const db = await createTestDb();
    const repo = createApplicationsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id, {
      title: "Staff Engineer",
      company: "Acme Corp",
      location: "Kuala Lumpur",
      salaryRaw: "RM12k-16k",
    });
    await insertJobScore(db, job.id, resume.id, { score: 4.7 });
    await repo.insertUniqueByJob({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      resumeId: resume.id,
      stage: 0,
      statusLabel: "Applied",
      statusTone: "good",
      note: "",
    });

    const { items } = await repo.listJoined({ userId: BOOTSTRAP_ADMIN_ID });
    expect(items).toHaveLength(1);
    expect(items[0].role).toBe("Staff Engineer");
    expect(items[0].company).toBe("Acme Corp");
    expect(items[0].meta).toBe("Kuala Lumpur · RM12k-16k");
    expect(items[0].score).toBe(4.7);
  });

  it("listJoined is scoped by userId — a second user's applications never leak into another user's list", async () => {
    const db = await createTestDb();
    const repo = createApplicationsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);
    await insertJobScore(db, job.id, resume.id);
    await repo.insertUniqueByJob({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      resumeId: resume.id,
      stage: 0,
      statusLabel: "Applied",
      statusTone: "good",
      note: "",
    });

    const [userB] = await db
      .insert(users)
      .values({ email: "user-b-applications-list@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();

    const { items } = await repo.listJoined({ userId: userB.id });
    expect(items).toHaveLength(0);
  });

  it("listJoined pages through every row with no drops when rows collide within a millisecond (regression)", async () => {
    const db = await createTestDb();
    const repo = createApplicationsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);

    const insertedIds: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      const job = await insertJob(db, source.id);
      await insertJobScore(db, job.id, resume.id);
      const [app] = await db
        .insert(applications)
        .values({
          userId: BOOTSTRAP_ADMIN_ID,
          jobId: job.id,
          resumeId: resume.id,
          stage: 0,
          statusLabel: "Applied",
          statusTone: "good",
          note: "",
          appliedAt: COLLIDING_TIMESTAMP,
        })
        .returning();
      insertedIds.push(app.id);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < insertedIds.length; i += 1) {
      const page = await repo.listJoined({ userId: BOOTSTRAP_ADMIN_ID, limit: 1, cursor });
      expect(page.items).toHaveLength(1);
      seen.push(page.items[0].id);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    expect(seen).toHaveLength(40);
    expect(new Set(seen).size).toBe(40);
    expect([...seen].sort()).toEqual([...insertedIds].sort());
  });

  it("listJoined/getJoined return the latest score once when a job has multiple score rows (regression)", async () => {
    const db = await createTestDb();
    const repo = createApplicationsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);

    await insertJobScore(db, job.id, resume.id, { policyVersion: "v1", score: 3.0 });
    await new Promise((r) => setTimeout(r, 5));
    await insertJobScore(db, job.id, resume.id, { policyVersion: "v2", score: 4.5 });

    const app = await repo.insertUniqueByJob({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      resumeId: resume.id,
      stage: 0,
      statusLabel: "Applied",
      statusTone: "good",
      note: "",
    });

    const { items } = await repo.listJoined({ userId: BOOTSTRAP_ADMIN_ID });
    expect(items).toHaveLength(1);
    expect(items[0].score).toBe(4.5);

    const found = await repo.getJoined(app.id, BOOTSTRAP_ADMIN_ID);
    expect(found?.score).toBe(4.5);
  });

  it("getJoined returns a single joined row", async () => {
    const db = await createTestDb();
    const repo = createApplicationsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);
    await insertJobScore(db, job.id, resume.id);
    const app = await repo.insertUniqueByJob({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      resumeId: resume.id,
      stage: 0,
      statusLabel: "Applied",
      statusTone: "good",
      note: "",
    });

    const found = await repo.getJoined(app.id, BOOTSTRAP_ADMIN_ID);
    expect(found?.id).toBe(app.id);
    expect(found?.role).toBeDefined();
  });

  it("getJoined is scoped by userId — a foreign-owned application resolves to null (no existence leak)", async () => {
    const db = await createTestDb();
    const repo = createApplicationsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);
    await insertJobScore(db, job.id, resume.id);
    const app = await repo.insertUniqueByJob({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      resumeId: resume.id,
      stage: 0,
      statusLabel: "Applied",
      statusTone: "good",
      note: "",
    });
    const [userB] = await db
      .insert(users)
      .values({ email: "user-b-applications-getjoined@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();

    expect(await repo.getJoined(app.id, userB.id)).toBeNull();
  });

  it("the cursor subquery is scoped by userId — a cursor encoding a foreign application id behaves identically to an unknown one (oracle fix)", async () => {
    const db = await createTestDb();
    const repo = createApplicationsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);
    await insertJobScore(db, job.id, resume.id);
    const app = await repo.insertUniqueByJob({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      resumeId: resume.id,
      stage: 0,
      statusLabel: "Applied",
      statusTone: "good",
      note: "",
    });
    const [userB] = await db
      .insert(users)
      .values({ email: "user-b-applications-cursor@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();

    const foreignCursor = encodeCursorId(app.id);
    const unknownCursor = encodeCursorId(crypto.randomUUID());

    const withForeignCursor = await repo.listJoined({ userId: userB.id, cursor: foreignCursor });
    const withUnknownCursor = await repo.listJoined({ userId: userB.id, cursor: unknownCursor });
    expect(withForeignCursor.items).toEqual(withUnknownCursor.items);
    expect(withForeignCursor.nextCursor).toEqual(withUnknownCursor.nextCursor);
  });

  it("patch updates stage/status/note", async () => {
    const db = await createTestDb();
    const repo = createApplicationsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);
    await insertJobScore(db, job.id, resume.id);
    const app = await repo.insertUniqueByJob({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      resumeId: resume.id,
      stage: 0,
      statusLabel: "Applied",
      statusTone: "good",
      note: "",
    });

    const patched = await repo.patch(app.id, BOOTSTRAP_ADMIN_ID, { stage: 1, statusLabel: "Screening", note: "recruiter call" });
    expect(patched?.stage).toBe(1);
    expect(patched?.statusLabel).toBe("Screening");
    expect(patched?.note).toBe("recruiter call");
  });

  it("patch is scoped by userId — a foreign-owned application is untouched (by-uuid PATCH leak fix)", async () => {
    const db = await createTestDb();
    const repo = createApplicationsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await insertJob(db, source.id);
    await insertJobScore(db, job.id, resume.id);
    const app = await repo.insertUniqueByJob({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      resumeId: resume.id,
      stage: 0,
      statusLabel: "Applied",
      statusTone: "good",
      note: "",
    });
    const [userB] = await db
      .insert(users)
      .values({ email: "user-b-applications-patch@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();

    const result = await repo.patch(app.id, userB.id, { stage: 3, statusLabel: "Offer", note: "hijacked" });
    expect(result).toBeNull();

    const [stillThere] = await db.select().from(applications).where(eq(applications.id, app.id));
    expect(stillThere.stage).toBe(0);
    expect(stillThere.statusLabel).toBe("Applied");
    expect(stillThere.note).toBe("");
  });
});
