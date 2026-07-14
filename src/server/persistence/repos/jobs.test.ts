import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { jobs, users } from "../schema";
import { createTestDb } from "../test-db";
import { encodeCursorId } from "./cursor";
import { insertJobScore, insertResume, insertSource } from "./__fixtures__/helpers";
import { createJobsRepo } from "./jobs";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

// Explicit, same-millisecond-different-microsecond firstSeenAt values —
// deterministic collision regardless of host/loop speed (JS Date can't
// represent microseconds, so this bypasses the driver's Date parsing via a
// raw SQL literal to set full-precision timestamps directly).
function collidingTimestamp(i: number): ReturnType<typeof sql> {
  const micros = (100000 + i).toString().padStart(6, "0");
  return sql.raw(`'2024-01-01 00:00:00.${micros}'::timestamp`);
}

describe("jobsRepo", () => {
  it("upsertByDedupeKey round-trips an insert", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);

    const inserted = await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey: "dk-1",
      url: "https://example.com/1",
      sourceId: source.id,
      title: "Backend Engineer",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "test fixture",
      aliases: [],
      raw: {},
    });

    expect(inserted.dedupeKey).toBe("dk-1");
    expect(inserted.title).toBe("Backend Engineer");
  });

  it("upsertByDedupeKey updates lastSeenAt/aliases and preserves firstSeenAt", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);

    const first = await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey: "dk-2",
      url: "https://example.com/2",
      sourceId: source.id,
      title: "Backend Engineer",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "test fixture",
      aliases: [],
      raw: {},
    });

    await new Promise((r) => setTimeout(r, 5));

    const second = await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey: "dk-2",
      url: "https://example.com/2",
      sourceId: source.id,
      title: "Backend Engineer (updated)",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "test fixture",
      aliases: [{ sourceId: "jobstreet", url: "https://jobstreet.com/2" }],
      raw: {},
    });

    expect(second.id).toBe(first.id);
    expect(second.firstSeenAt.getTime()).toBe(first.firstSeenAt.getTime());
    expect(second.lastSeenAt.getTime()).toBeGreaterThan(first.lastSeenAt.getTime());
    expect(second.aliases).toEqual([{ sourceId: "jobstreet", url: "https://jobstreet.com/2" }]);
  });

  it("getByDedupeKey finds an existing row, null for an unknown key", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);

    await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey: "dk-getbykey",
      url: "https://example.com/getbykey",
      sourceId: source.id,
      title: "Backend Engineer",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "test fixture",
      aliases: [],
      raw: {},
    });

    const found = await repo.getByDedupeKey("dk-getbykey", BOOTSTRAP_ADMIN_ID);
    expect(found?.dedupeKey).toBe("dk-getbykey");

    const missing = await repo.getByDedupeKey("dk-does-not-exist", BOOTSTRAP_ADMIN_ID);
    expect(missing).toBeNull();
  });

  it("hasAnyScore is false for a persisted-but-unscored job, true once a job_scores row exists (final review fix wave FIX 1a)", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);

    const job = await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey: "dk-hasanyscore",
      url: "https://example.com/hasanyscore",
      sourceId: source.id,
      title: "Backend Engineer",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "test fixture",
      aliases: [],
      raw: {},
    });

    expect(await repo.hasAnyScore(job.id, BOOTSTRAP_ADMIN_ID)).toBe(false);

    await insertJobScore(db, job.id, resume.id);

    expect(await repo.hasAnyScore(job.id, BOOTSTRAP_ADMIN_ID)).toBe(true);
  });

  it("upsertByDedupeKey merges aliases across re-sightings instead of replacing them (regression)", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);

    const first = await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey: "dk-alias-merge",
      url: "https://example.com/3",
      sourceId: source.id,
      title: "Backend Engineer",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "test fixture",
      aliases: [{ sourceId: "jobstreet", url: "https://jobstreet.com/3" }],
      raw: {},
    });
    expect(first.aliases).toEqual([{ sourceId: "jobstreet", url: "https://jobstreet.com/3" }]);

    // Re-sighting from a run that only found a different alias this time —
    // the jobstreet alias from the first sighting must be preserved, not wiped.
    const second = await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey: "dk-alias-merge",
      url: "https://example.com/3",
      sourceId: source.id,
      title: "Backend Engineer",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "test fixture",
      aliases: [{ sourceId: "hiredly", url: "https://hiredly.com/3" }],
      raw: {},
    });
    expect(second.aliases).toEqual(
      expect.arrayContaining([
        { sourceId: "jobstreet", url: "https://jobstreet.com/3" },
        { sourceId: "hiredly", url: "https://hiredly.com/3" },
      ]),
    );
    expect(second.aliases).toHaveLength(2);

    // Re-sighting the exact same alias again does not duplicate it.
    const third = await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey: "dk-alias-merge",
      url: "https://example.com/3",
      sourceId: source.id,
      title: "Backend Engineer",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "test fixture",
      aliases: [{ sourceId: "hiredly", url: "https://hiredly.com/3" }],
      raw: {},
    });
    expect(third.aliases).toHaveLength(2);
  });

  it("does not merge another user's aliases when upserting a job with the same dedupeKey (cross-tenant isolation)", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);

    const [userB] = await db
      .insert(users)
      .values({ email: "user-b-jobs@example.com", passwordHash: "h", role: "user" })
      .returning();

    const dedupeKey = "dk-cross-tenant";

    const jobA = await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey,
      url: "https://example.com/cross-tenant-a",
      sourceId: source.id,
      title: "Backend Engineer",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "test fixture",
      aliases: [{ sourceId: "jobstreet", url: "https://jobstreet.com/cross-tenant-a" }],
      raw: {},
    });

    const jobB = await repo.upsertByDedupeKey({
      userId: userB.id,
      dedupeKey,
      url: "https://example.com/cross-tenant-b",
      sourceId: source.id,
      title: "Backend Engineer",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "test fixture",
      aliases: [{ sourceId: "hiredly", url: "https://hiredly.com/cross-tenant-b" }],
      raw: {},
    });

    expect(jobA.id).not.toBe(jobB.id);
    expect(jobB.aliases).toEqual([{ sourceId: "hiredly", url: "https://hiredly.com/cross-tenant-b" }]);
    expect(jobB.aliases).not.toContainEqual({ sourceId: "jobstreet", url: "https://jobstreet.com/cross-tenant-a" });

    const rows = await db.select().from(jobs).where(eq(jobs.dedupeKey, dedupeKey));
    expect(rows).toHaveLength(2);
  });

  it("listScored filters by tier + minScore and pages with a cursor", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);

    const rows: { jobId: string }[] = [];
    for (let i = 0; i < 3; i += 1) {
      const job = await repo.upsertByDedupeKey({
        userId: BOOTSTRAP_ADMIN_ID,
        dedupeKey: `dk-tier-${i}`,
        url: `https://example.com/tier-${i}`,
        sourceId: source.id,
        title: `Job ${i}`,
        company: "Acme",
        location: "Remote",
        persona: "remote",
        eligibility: "unknown",
        eligibilityEvidence: "test fixture",
        aliases: [],
        raw: {},
      });
      await insertJobScore(db, job.id, resume.id, {
        score: 4.5 - i * 0.1,
        legitimacy: { tier: i === 2 ? "suspicious" : "clear", tone: "good", summary: "x", signals: [] },
      });
      rows.push({ jobId: job.id });
    }

    const page1 = await repo.listScored({ userId: BOOTSTRAP_ADMIN_ID, tier: ["clear"], minScore: 4, limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.items[0].score.legitimacy.tier).toBe("clear");

    const page2 = await repo.listScored({
      userId: BOOTSTRAP_ADMIN_ID,
      tier: ["clear"],
      minScore: 4,
      limit: 1,
      cursor: page1.nextCursor!,
    });
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0].job.id).not.toBe(page1.items[0].job.id);
    expect(page2.nextCursor).toBeNull();
  });

  it("listScored pages through every row with no drops when rows collide within a millisecond (regression)", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);

    const insertedIds: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      const [job] = await db
        .insert(jobs)
        .values({
          userId: BOOTSTRAP_ADMIN_ID,
          dedupeKey: `dk-cursor-${i}`,
          url: `https://example.com/cursor-${i}`,
          sourceId: source.id,
          title: `Cursor Job ${i}`,
          company: "Acme",
          location: "Remote",
          persona: "remote",
          eligibility: "unknown",
          eligibilityEvidence: "test fixture",
          aliases: [],
          raw: {},
          firstSeenAt: collidingTimestamp(i) as unknown as Date,
        })
        .returning();
      await insertJobScore(db, job.id, resume.id);
      insertedIds.push(job.id);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < insertedIds.length; i += 1) {
      const page = await repo.listScored({ userId: BOOTSTRAP_ADMIN_ID, limit: 1, cursor });
      expect(page.items).toHaveLength(1);
      seen.push(page.items[0].job.id);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    expect(seen).toHaveLength(40);
    expect(new Set(seen).size).toBe(40);
    expect([...seen].sort()).toEqual([...insertedIds].sort());
  });

  it("listScored/getById return the latest score once when a job has multiple score rows (regression)", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);

    const job = await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey: "dk-multi-score",
      url: "https://example.com/multi-score",
      sourceId: source.id,
      title: "Multi Score Job",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "test fixture",
      aliases: [],
      raw: {},
    });

    await insertJobScore(db, job.id, resume.id, { policyVersion: "v1", score: 3.0 });
    await new Promise((r) => setTimeout(r, 5));
    const newer = await insertJobScore(db, job.id, resume.id, { policyVersion: "v2", score: 4.5 });

    const { items } = await repo.listScored({ userId: BOOTSTRAP_ADMIN_ID });
    const matches = items.filter((i) => i.job.id === job.id);
    expect(matches).toHaveLength(1);
    expect(matches[0].score.id).toBe(newer.id);

    const found = await repo.getById(job.id, BOOTSTRAP_ADMIN_ID);
    expect(found?.score.id).toBe(newer.id);
  });

  it("statsForQuery aggregates over the FULL scoped set, not a page", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);

    const verdicts: ("Apply" | "Consider" | "Research first" | "Skip")[] = ["Apply", "Consider", "Research first", "Skip"];
    const tiers: ("clear" | "suspicious" | "ghost" | "scam" | "verified")[] = ["clear", "suspicious", "ghost", "scam", "verified"];

    for (let i = 0; i < 10; i += 1) {
      const job = await repo.upsertByDedupeKey({
        userId: BOOTSTRAP_ADMIN_ID,
        dedupeKey: `dk-stats-${i}`,
        url: `https://example.com/stats-${i}`,
        sourceId: source.id,
        title: `Job ${i}`,
        company: "Acme",
        location: "Remote",
        persona: "remote",
        eligibility: "unknown",
        eligibilityEvidence: "test fixture",
        aliases: [],
        raw: {},
      });
      await insertJobScore(db, job.id, resume.id, {
        verdict: verdicts[i % verdicts.length],
        legitimacy: { tier: tiers[i % tiers.length], tone: "good", summary: "x", signals: [] },
      });
    }

    const stats = await repo.statsForQuery({ userId: BOOTSTRAP_ADMIN_ID });
    expect(stats.scanned).toBe(10);
    // verdicts cycle 0..9 (period 4): Apply at 0,4,8; Consider at 1,5,9 -> 6 worth
    expect(stats.worth).toBe(6);
    // tiers cycle 0..9: ghost at i=2,7 -> 2 ghosts
    expect(stats.ghosts).toBe(2);
    // flagged = suspicious|ghost|scam: i=1,2,3,6,7,8 -> 6
    expect(stats.flagged).toBe(6);

    const page = await repo.listScored({ userId: BOOTSTRAP_ADMIN_ID, limit: 2 });
    expect(page.items).toHaveLength(2);
    // the full-set stats must not shrink to match the small page
    expect(stats.scanned).toBeGreaterThan(page.items.length);
  });

  it("statsForQuery's sinceLast counts only rows newer than the given cutoff, 0 without one", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);

    const older = await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey: "dk-older",
      url: "https://example.com/older",
      sourceId: source.id,
      title: "Older Job",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "test fixture",
      aliases: [],
      raw: {},
      firstSeenAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await insertJobScore(db, older.id, resume.id);

    const newer = await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey: "dk-newer",
      url: "https://example.com/newer",
      sourceId: source.id,
      title: "Newer Job",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "test fixture",
      aliases: [],
      raw: {},
      firstSeenAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    await insertJobScore(db, newer.id, resume.id);

    const withCutoff = await repo.statsForQuery({ userId: BOOTSTRAP_ADMIN_ID }, new Date("2026-03-01T00:00:00.000Z"));
    expect(withCutoff.sinceLast).toBe(1);

    const withoutCutoff = await repo.statsForQuery({ userId: BOOTSTRAP_ADMIN_ID });
    expect(withoutCutoff.sinceLast).toBe(0);
  });

  it("getById returns the joined job+score", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey: "dk-single",
      url: "https://example.com/single",
      sourceId: source.id,
      title: "Job Single",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "test fixture",
      aliases: [],
      raw: {},
    });
    await insertJobScore(db, job.id, resume.id);

    const found = await repo.getById(job.id, BOOTSTRAP_ADMIN_ID);
    expect(found?.job.id).toBe(job.id);
    expect(found?.score.jobId).toBe(job.id);
  });

  it("updateDescription persists the description and returns the updated row", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);
    const job = await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey: "dk-update-description",
      url: "https://example.com/update-description",
      sourceId: source.id,
      title: "Job Needing Description",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "test fixture",
      aliases: [],
      raw: {},
    });
    expect(job.description).toBeNull();

    const updated = await repo.updateDescription(job.id, BOOTSTRAP_ADMIN_ID, "Full JD text.");
    expect(updated.id).toBe(job.id);
    expect(updated.description).toBe("Full JD text.");
  });

  it("updateDescription throws for an unknown job id (fail loud)", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    await expect(repo.updateDescription(crypto.randomUUID(), BOOTSTRAP_ADMIN_ID, "text")).rejects.toThrow(/no job/);
  });

  it("existsById is true for an unscored job (unlike getById) and false for an unknown id", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);
    const job = await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey: "dk-unscored",
      url: "https://example.com/unscored",
      sourceId: source.id,
      title: "Job Unscored",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "test fixture",
      aliases: [],
      raw: {},
    });

    expect(await repo.existsById(job.id, BOOTSTRAP_ADMIN_ID)).toBe(true);
    expect(await repo.getById(job.id, BOOTSTRAP_ADMIN_ID)).toBeNull();
    expect(await repo.existsById(crypto.randomUUID(), BOOTSTRAP_ADMIN_ID)).toBe(false);
  });

  it("getRowWithSourceById returns the joined job+source row, undefined for an unknown id", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);
    const job = await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey: "dk-with-source",
      url: "https://example.com/with-source",
      sourceId: source.id,
      title: "Job With Source",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "test fixture",
      aliases: [],
      raw: {},
    });

    const found = await repo.getRowWithSourceById(job.id, BOOTSTRAP_ADMIN_ID);
    expect(found?.job.id).toBe(job.id);
    expect(found?.source.id).toBe(source.id);

    expect(await repo.getRowWithSourceById(crypto.randomUUID(), BOOTSTRAP_ADMIN_ID)).toBeUndefined();
  });

  it("updateEligibility overwrites tier + evidence and throws on unknown id", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);
    const job = await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey: "dk-eligibility",
      url: "https://example.com/eligibility",
      sourceId: source.id,
      title: "Eligibility Job",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "test fixture",
      aliases: [],
      raw: {},
    });

    await repo.updateEligibility(job.id, BOOTSTRAP_ADMIN_ID, "eligible", "JD: hires in APAC");
    const after = await repo.getRowWithSourceById(job.id, BOOTSTRAP_ADMIN_ID);
    expect(after?.job.eligibility).toBe("eligible");
    expect(after?.job.eligibilityEvidence).toBe("JD: hires in APAC");

    await expect(repo.updateEligibility(crypto.randomUUID(), BOOTSTRAP_ADMIN_ID, "unknown", "x")).rejects.toThrow(
      /no job with id/,
    );
  });

  it("updateRemoteFit sets tz_band and hiring_structure", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);
    const job = await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey: "dk-remote-fit",
      url: "https://example.com/remote-fit",
      sourceId: source.id,
      title: "Remote Fit Job",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "test fixture",
      aliases: [],
      raw: {},
    });

    await repo.updateRemoteFit(job.id, BOOTSTRAP_ADMIN_ID, "americas", "contractor");
    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row.tzBand).toBe("americas");
    expect(row.hiringStructure).toBe("contractor");

    await expect(repo.updateRemoteFit(crypto.randomUUID(), BOOTSTRAP_ADMIN_ID, null, null)).rejects.toThrow(
      /no job with id/,
    );
  });

  it("updateRemoteFit does not update a job belonging to another user (cross-tenant isolation)", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);
    const [userB] = await db
      .insert(users)
      .values({ email: "user-b-remote-fit@example.com", passwordHash: "h", role: "user" })
      .returning();
    const job = await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey: "dk-remote-fit-tenant",
      url: "https://example.com/remote-fit-tenant",
      sourceId: source.id,
      title: "Remote Fit Tenant Job",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "test fixture",
      aliases: [],
      raw: {},
    });

    await expect(repo.updateRemoteFit(job.id, userB.id, "americas", "contractor")).rejects.toThrow(
      /no job with id/,
    );
    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row.tzBand).toBeNull();
    expect(row.hiringStructure).toBeNull();
  });

  it("filters by eligibility[]", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const mk = async (eligibility: "anywhere" | "abroad" | "unknown") => {
      const job = await repo.upsertByDedupeKey({
        userId: BOOTSTRAP_ADMIN_ID,
        dedupeKey: `dk-elig-${eligibility}`,
        url: `https://example.com/elig-${eligibility}`,
        sourceId: source.id,
        title: "Backend Engineer",
        company: "Acme",
        location: "Remote",
        persona: "remote",
        eligibility,
        eligibilityEvidence: "t",
        aliases: [],
        raw: {},
      });
      await insertJobScore(db, job.id, resume.id);
      return job;
    };
    await mk("anywhere");
    await mk("abroad");
    await mk("unknown");

    const { items } = await repo.listScored({
      userId: BOOTSTRAP_ADMIN_ID,
      eligibility: ["anywhere", "eligible", "local", "unknown"],
    });
    expect(items).toHaveLength(2);
  });

  it("filters by tzBands: NULL passes, listed bands pass, others hidden", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const mk = async (tzBand: "apac" | "americas" | null, key: string) => {
      const job = await repo.upsertByDedupeKey({
        userId: BOOTSTRAP_ADMIN_ID,
        dedupeKey: `dk-tzband-${key}`,
        url: `https://example.com/tzband-${key}`,
        sourceId: source.id,
        title: "Backend Engineer",
        company: "Acme",
        location: "Remote",
        persona: "remote",
        eligibility: "unknown",
        eligibilityEvidence: "t",
        aliases: [],
        raw: {},
        tzBand,
      });
      await insertJobScore(db, job.id, resume.id);
      return job;
    };
    await mk(null, "null"); // passes (unstated)
    await mk("apac", "apac"); // passes (allowed)
    await mk("americas", "americas"); // hidden

    const { items } = await repo.listScored({ userId: BOOTSTRAP_ADMIN_ID, tzBands: ["apac"] });
    expect(items).toHaveLength(2);
  });

  it("filters by hiringStructures: NULL passes, listed pass, others hidden", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const mk = async (hiringStructure: "eor" | "contractor" | null, key: string) => {
      const job = await repo.upsertByDedupeKey({
        userId: BOOTSTRAP_ADMIN_ID,
        dedupeKey: `dk-hiring-${key}`,
        url: `https://example.com/hiring-${key}`,
        sourceId: source.id,
        title: "Backend Engineer",
        company: "Acme",
        location: "Remote",
        persona: "remote",
        eligibility: "unknown",
        eligibilityEvidence: "t",
        aliases: [],
        raw: {},
        hiringStructure,
      });
      await insertJobScore(db, job.id, resume.id);
      return job;
    };
    await mk(null, "null"); // passes (unstated)
    await mk("eor", "eor"); // passes (allowed)
    await mk("contractor", "contractor"); // hidden

    const { items } = await repo.listScored({ userId: BOOTSTRAP_ADMIN_ID, hiringStructures: ["local-entity", "eor"] });
    expect(items).toHaveLength(2);
  });

  it("countHidden ORs hidden tiers/bands/structures, scored or not, scoped by persona", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const mk = async (
      overrides: Partial<{
        eligibility: "anywhere" | "abroad" | "unknown";
        tzBand: "apac" | "americas" | null;
        hiringStructure: "eor" | "contractor" | null;
      }>,
      opts: { key: string; persona?: "remote" | "local"; scored?: boolean },
    ) => {
      const job = await repo.upsertByDedupeKey({
        userId: BOOTSTRAP_ADMIN_ID,
        dedupeKey: `dk-hidden-${opts.key}`,
        url: `https://example.com/hidden-${opts.key}`,
        sourceId: source.id,
        title: "Backend Engineer",
        company: "Acme",
        location: "Remote",
        persona: opts.persona ?? "remote",
        eligibility: overrides.eligibility ?? "unknown",
        eligibilityEvidence: "t",
        aliases: [],
        raw: {},
        tzBand: overrides.tzBand ?? null,
        hiringStructure: overrides.hiringStructure ?? null,
      });
      if (opts.scored ?? true) await insertJobScore(db, job.id, resume.id);
      return job;
    };

    await mk({ eligibility: "anywhere" }, { key: "anywhere" }); // admitted tier — never hidden
    await mk({}, { key: "unknown" }); // admitted tier, unstated band/structure — never hidden
    await mk({ eligibility: "abroad" }, { key: "abroad-scored", scored: true }); // hidden tier, scored
    await mk({ eligibility: "abroad" }, { key: "abroad-unscored", scored: false }); // hidden tier, gated out of scoring entirely
    await mk({ eligibility: "abroad" }, { key: "abroad-other-persona", persona: "local" }); // hidden but wrong persona scope
    await mk({ tzBand: "americas" }, { key: "band-hidden" }); // hidden band, admitted tier — OR, not AND
    await mk({ hiringStructure: "contractor" }, { key: "structure-hidden" }); // hidden structure, admitted tier — OR, not AND

    const hidden = await repo.countHidden(
      { userId: BOOTSTRAP_ADMIN_ID, persona: "remote" },
      { tiers: ["abroad"], bands: ["americas"], structures: ["contractor"] },
    );
    expect(hidden).toBe(4); // abroad-scored, abroad-unscored, band-hidden, structure-hidden
  });

  it("countHidden returns 0 without a query when all hidden sets are empty", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    expect(await repo.countHidden({ userId: BOOTSTRAP_ADMIN_ID }, {})).toBe(0);
  });
});

// Step 3 task 3: read scoping + cursor-oracle fix (Fable design review).
describe("jobsRepo — cross-tenant isolation", () => {
  async function makeUserB(db: Awaited<ReturnType<typeof createTestDb>>) {
    const [userB] = await db
      .insert(users)
      .values({ email: `user-b-jobs-isolation-${crypto.randomUUID()}@example.com`, passwordHash: "h", role: "user" })
      .returning();
    return userB;
  }

  it("A's feed (listScored) excludes B's jobs, and vice versa", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);
    const resumeA = await insertResume(db);
    const userB = await makeUserB(db);
    const resumeB = await insertResume(db, { userId: userB.id });

    const jobA = await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey: "dk-isolation-a",
      url: "https://example.com/isolation-a",
      sourceId: source.id,
      title: "A's Job",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "t",
      aliases: [],
      raw: {},
    });
    await insertJobScore(db, jobA.id, resumeA.id);

    const jobB = await repo.upsertByDedupeKey({
      userId: userB.id,
      dedupeKey: "dk-isolation-b",
      url: "https://example.com/isolation-b",
      sourceId: source.id,
      title: "B's Job",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "t",
      aliases: [],
      raw: {},
    });
    await insertJobScore(db, jobB.id, resumeB.id);

    const feedA = await repo.listScored({ userId: BOOTSTRAP_ADMIN_ID });
    expect(feedA.items.map((i) => i.job.id)).toEqual([jobA.id]);

    const feedB = await repo.listScored({ userId: userB.id });
    expect(feedB.items.map((i) => i.job.id)).toEqual([jobB.id]);
  });

  it("countHidden scopes the hidden count to the caller's own jobs", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);
    const userB = await makeUserB(db);

    await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey: "dk-hidden-isolation-a",
      url: "https://example.com/hidden-isolation-a",
      sourceId: source.id,
      title: "A's Hidden Job",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "abroad",
      eligibilityEvidence: "t",
      aliases: [],
      raw: {},
    });
    await repo.upsertByDedupeKey({
      userId: userB.id,
      dedupeKey: "dk-hidden-isolation-b",
      url: "https://example.com/hidden-isolation-b",
      sourceId: source.id,
      title: "B's Hidden Job",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "abroad",
      eligibilityEvidence: "t",
      aliases: [],
      raw: {},
    });

    const hiddenA = await repo.countHidden({ userId: BOOTSTRAP_ADMIN_ID }, { tiers: ["abroad"] });
    expect(hiddenA).toBe(1);

    const hiddenB = await repo.countHidden({ userId: userB.id }, { tiers: ["abroad"] });
    expect(hiddenB).toBe(1);
  });

  it("getById/getRowWithSourceById/existsById return null/undefined/false for a foreign job id (404, never a leak)", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const userB = await makeUserB(db);

    const job = await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey: "dk-isolation-getters",
      url: "https://example.com/isolation-getters",
      sourceId: source.id,
      title: "A's Job",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "t",
      aliases: [],
      raw: {},
    });
    await insertJobScore(db, job.id, resume.id);

    expect(await repo.getById(job.id, userB.id)).toBeNull();
    expect(await repo.getRowWithSourceById(job.id, userB.id)).toBeUndefined();
    expect(await repo.existsById(job.id, userB.id)).toBe(false);
    expect(await repo.hasAnyScore(job.id, userB.id)).toBe(false);

    // Sanity: the owner still sees it.
    expect(await repo.getById(job.id, BOOTSTRAP_ADMIN_ID)).not.toBeNull();
  });

  it("updateDescription/updateEligibility throw for a foreign job id (a foreign id must not be mutated)", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);
    const userB = await makeUserB(db);

    const job = await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey: "dk-isolation-writes",
      url: "https://example.com/isolation-writes",
      sourceId: source.id,
      title: "A's Job",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "t",
      aliases: [],
      raw: {},
    });

    await expect(repo.updateDescription(job.id, userB.id, "hijacked")).rejects.toThrow(/no job/);
    await expect(repo.updateEligibility(job.id, userB.id, "eligible", "hijacked")).rejects.toThrow(/no job with id/);

    const after = await repo.getRowWithSourceById(job.id, BOOTSTRAP_ADMIN_ID);
    expect(after?.job.description).toBeNull();
    expect(after?.job.eligibility).toBe("unknown");
  });

  it("getByDedupeKey returns only the caller's own row when A and B each own a job under the same dedupeKey", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);
    const userB = await makeUserB(db);
    const dedupeKey = "dk-isolation-samekey";

    const jobA = await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey,
      url: "https://example.com/isolation-samekey-a",
      sourceId: source.id,
      title: "A's Job",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "t",
      aliases: [],
      raw: {},
    });
    const jobB = await repo.upsertByDedupeKey({
      userId: userB.id,
      dedupeKey,
      url: "https://example.com/isolation-samekey-b",
      sourceId: source.id,
      title: "B's Job",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "t",
      aliases: [],
      raw: {},
    });

    expect((await repo.getByDedupeKey(dedupeKey, BOOTSTRAP_ADMIN_ID))?.id).toBe(jobA.id);
    expect((await repo.getByDedupeKey(dedupeKey, userB.id))?.id).toBe(jobB.id);
  });

  // The cursor-oracle fix (task-3-brief.md item 2): before the fix, the
  // cursor subquery at listScored's `WHERE id = ${c.id}` carried NO user_id
  // filter, so a cursor encoding a foreign-but-real job id resolved to a
  // real row (producing a normal, non-empty page) while a cursor encoding a
  // truly nonexistent id resolved to nothing (producing an empty page) — an
  // existence oracle across tenants. Both must now be indistinguishable.
  it("a cursor encoding A's job id behaves identically to a cursor encoding a nonexistent id, when read as B", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);
    const resumeA = await insertResume(db);
    const userB = await makeUserB(db);
    const resumeB = await insertResume(db, { userId: userB.id });

    const jobA = await repo.upsertByDedupeKey({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey: "dk-oracle-a",
      url: "https://example.com/oracle-a",
      sourceId: source.id,
      title: "A's Job",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "t",
      aliases: [],
      raw: {},
    });
    await insertJobScore(db, jobA.id, resumeA.id);

    // B owns a job too, older than A's, so a correctly-scoped cursor query
    // (one that finds no matching row for the cursor id) still has a
    // candidate row it *could* return — making the oracle observable if the
    // subquery leaked A's real firstSeenAt instead of NULL.
    const jobBOlder = await repo.upsertByDedupeKey({
      userId: userB.id,
      dedupeKey: "dk-oracle-b-older",
      url: "https://example.com/oracle-b-older",
      sourceId: source.id,
      title: "B's older job",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "t",
      aliases: [],
      raw: {},
      firstSeenAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    await insertJobScore(db, jobBOlder.id, resumeB.id);

    const cursorEncodingForeignJob = encodeCursorId(jobA.id);
    const cursorEncodingNonexistentId = encodeCursorId(crypto.randomUUID());

    const pageViaForeignCursor = await repo.listScored({ userId: userB.id, cursor: cursorEncodingForeignJob });
    const pageViaNonexistentCursor = await repo.listScored({ userId: userB.id, cursor: cursorEncodingNonexistentId });

    expect(pageViaForeignCursor.items.map((i) => i.job.id)).toEqual(pageViaNonexistentCursor.items.map((i) => i.job.id));
    expect(pageViaForeignCursor.nextCursor).toBe(pageViaNonexistentCursor.nextCursor);
    // Both must be empty — neither is a valid "less than A's firstSeenAt"
    // comparison from B's perspective (subquery resolves to NULL in both
    // cases), so nothing before an unresolvable cursor can be paginated.
    expect(pageViaForeignCursor.items).toHaveLength(0);
  });
});
