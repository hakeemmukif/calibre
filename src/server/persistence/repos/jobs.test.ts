import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { jobs, users } from "../schema";
import { createTestDb } from "../test-db";
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

    const found = await repo.getByDedupeKey("dk-getbykey");
    expect(found?.dedupeKey).toBe("dk-getbykey");

    const missing = await repo.getByDedupeKey("dk-does-not-exist");
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

    expect(await repo.hasAnyScore(job.id)).toBe(false);

    await insertJobScore(db, job.id, resume.id);

    expect(await repo.hasAnyScore(job.id)).toBe(true);
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

    const page1 = await repo.listScored({ tier: ["clear"], minScore: 4, limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.items[0].score.legitimacy.tier).toBe("clear");

    const page2 = await repo.listScored({ tier: ["clear"], minScore: 4, limit: 1, cursor: page1.nextCursor! });
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
      const page = await repo.listScored({ limit: 1, cursor });
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

    const { items } = await repo.listScored({});
    const matches = items.filter((i) => i.job.id === job.id);
    expect(matches).toHaveLength(1);
    expect(matches[0].score.id).toBe(newer.id);

    const found = await repo.getById(job.id);
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

    const stats = await repo.statsForQuery({});
    expect(stats.scanned).toBe(10);
    // verdicts cycle 0..9 (period 4): Apply at 0,4,8; Consider at 1,5,9 -> 6 worth
    expect(stats.worth).toBe(6);
    // tiers cycle 0..9: ghost at i=2,7 -> 2 ghosts
    expect(stats.ghosts).toBe(2);
    // flagged = suspicious|ghost|scam: i=1,2,3,6,7,8 -> 6
    expect(stats.flagged).toBe(6);

    const page = await repo.listScored({ limit: 2 });
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

    const withCutoff = await repo.statsForQuery({}, new Date("2026-03-01T00:00:00.000Z"));
    expect(withCutoff.sinceLast).toBe(1);

    const withoutCutoff = await repo.statsForQuery({});
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

    const found = await repo.getById(job.id);
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

    const updated = await repo.updateDescription(job.id, "Full JD text.");
    expect(updated.id).toBe(job.id);
    expect(updated.description).toBe("Full JD text.");
  });

  it("updateDescription throws for an unknown job id (fail loud)", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    await expect(repo.updateDescription(crypto.randomUUID(), "text")).rejects.toThrow(/no job/);
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

    expect(await repo.existsById(job.id)).toBe(true);
    expect(await repo.getById(job.id)).toBeNull();
    expect(await repo.existsById(crypto.randomUUID())).toBe(false);
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

    const found = await repo.getRowWithSourceById(job.id);
    expect(found?.job.id).toBe(job.id);
    expect(found?.source.id).toBe(source.id);

    expect(await repo.getRowWithSourceById(crypto.randomUUID())).toBeUndefined();
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

    await repo.updateEligibility(job.id, "eligible", "JD: hires in APAC");
    const after = await repo.getRowWithSourceById(job.id);
    expect(after?.job.eligibility).toBe("eligible");
    expect(after?.job.eligibilityEvidence).toBe("JD: hires in APAC");

    await expect(repo.updateEligibility(crypto.randomUUID(), "unknown", "x")).rejects.toThrow(/no job with id/);
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

    const { items } = await repo.listScored({ eligibility: ["anywhere", "eligible", "local", "unknown"] });
    expect(items).toHaveLength(2);
  });

  it("countHiddenByEligibility counts everything the predicate hid, scored or not, scoped by persona", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const mk = async (
      eligibility: "anywhere" | "abroad" | "unknown",
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
        eligibility,
        eligibilityEvidence: "t",
        aliases: [],
        raw: {},
      });
      if (opts.scored ?? true) await insertJobScore(db, job.id, resume.id);
      return job;
    };

    await mk("anywhere", { key: "anywhere" }); // admitted tier — never hidden
    await mk("unknown", { key: "unknown" }); // admitted tier — never hidden
    await mk("abroad", { key: "abroad-scored", scored: true }); // hidden, scored
    await mk("abroad", { key: "abroad-unscored", scored: false }); // hidden, gated out of scoring entirely
    await mk("abroad", { key: "abroad-other-persona", persona: "local" }); // hidden but wrong persona scope

    const hidden = await repo.countHiddenByEligibility({ persona: "remote", eligibility: ["abroad"] });
    expect(hidden).toBe(2);
  });
});
