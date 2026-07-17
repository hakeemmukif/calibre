import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./test-db";
import { countUserRows, deleteUser } from "./delete-user";
import {
  applicationAnswers,
  applications,
  correlationReports,
  creditLedger,
  profile,
  searchRuns,
  sessions,
  tailoredResumes,
  urlChecks,
  users,
} from "./schema";
import { insertJob, insertJobScore, insertResume, insertSource } from "./repos/__fixtures__/helpers";

async function seedFullGraph(db: TestDb, userId: string, suffix: string) {
  const source = await insertSource(db);
  const resume = await insertResume(db, { userId, isActive: true });
  const job = await insertJob(db, source.id, { userId });
  await insertJobScore(db, job.id, resume.id, { userId });
  await db.insert(sessions).values({ userId, tokenHash: `tok-${suffix}` });
  await db.insert(profile).values({
    id: `profile-${suffix}`,
    userId,
    baseCountry: "MY",
    relocation: "stay",
    scheduleFlex: "any-hours",
    employmentPref: "any",
  });
  await db.insert(searchRuns).values({
    userId,
    resumeId: resume.id,
    personas: ["remote"],
    status: "completed",
    stats: { scanned: 1, matched: 1, scored: 1, worth: 1, ghosts: 0, perSource: [] },
  });
  const [report] = await db
    .insert(correlationReports)
    .values({ userId, jobId: job.id, resumeId: resume.id, rows: [], status: "completed", model: "test-model" })
    .returning();
  const [tailored] = await db
    .insert(tailoredResumes)
    .values({
      userId,
      jobId: job.id,
      baseResumeId: resume.id,
      reportId: report.id,
      diff: [],
      status: "completed",
      model: "test-model",
    })
    .returning();
  const [answers] = await db
    .insert(applicationAnswers)
    .values({ userId, jobId: job.id, resumeId: resume.id, formSource: "pasted", answers: [], model: "test-model", costUsd: 0 })
    .returning();
  await db.insert(applications).values({
    userId,
    jobId: job.id,
    resumeId: resume.id,
    tailoredResumeId: tailored.id,
    answersId: answers.id,
    stage: 0,
    statusLabel: "Applied",
    statusTone: "good",
    note: "",
  });
  await db.insert(creditLedger).values({ userId, delta: 30, reason: "signup" });
  await db.insert(urlChecks).values({
    userId,
    url: `https://example.com/check-${suffix}`,
    dedupeKey: `check-${suffix}`,
    status: "completed",
    alreadyKnown: false,
    needsText: false,
    costUsd: 0,
    raw: {},
  });
}

describe("deleteUser (Task 5 — 13-table FK-safe delete)", () => {
  let db: TestDb;
  let uploads: string;

  beforeEach(async () => {
    db = await createTestDb();
    uploads = mkdtempSync(join(tmpdir(), "caliber-uploads-"));
    process.env.CALIBER_UPLOADS_DIR = uploads;
  });

  afterEach(() => {
    delete process.env.CALIBER_UPLOADS_DIR;
  });

  it("removes every row across all 13 tables + the uploads dir; the second user is untouched", async () => {
    const [userA] = await db
      .insert(users)
      .values({ email: "a@del.co", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    const [userB] = await db
      .insert(users)
      .values({ email: "b@del.co", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    await seedFullGraph(db, userA.id, "a");
    await seedFullGraph(db, userB.id, "b");
    mkdirSync(join(uploads, userA.id), { recursive: true });
    writeFileSync(join(uploads, userA.id, "resume.pdf"), "pdf");
    mkdirSync(join(uploads, userB.id), { recursive: true });

    const before = await countUserRows(db, userA.id);
    expect(Object.keys(before)).toHaveLength(13);
    expect(Object.values(before).every((n) => n >= 1)).toBe(true); // full graph seeded

    await deleteUser(db, userA.id);

    const after = await countUserRows(db, userA.id);
    expect(Object.values(after).every((n) => n === 0)).toBe(true);
    expect(existsSync(join(uploads, userA.id))).toBe(false);

    const bAfter = await countUserRows(db, userB.id);
    expect(Object.values(bAfter).every((n) => n >= 1)).toBe(true);
    expect(existsSync(join(uploads, userB.id))).toBe(true);
  });

  it("re-runs cleanly (idempotent — every delete is a no-op the second time)", async () => {
    const [userA] = await db
      .insert(users)
      .values({ email: "rerun@del.co", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    await deleteUser(db, userA.id);
    await expect(deleteUser(db, userA.id)).resolves.toBeUndefined();
  });
});
