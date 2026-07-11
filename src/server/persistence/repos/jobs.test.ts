import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { insertJobScore, insertResume, insertSource } from "./__fixtures__/helpers";
import { createJobsRepo } from "./jobs";

describe("jobsRepo", () => {
  it("upsertByDedupeKey round-trips an insert", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);

    const inserted = await repo.upsertByDedupeKey({
      dedupeKey: "dk-1",
      url: "https://example.com/1",
      sourceId: source.id,
      title: "Backend Engineer",
      company: "Acme",
      location: "Remote",
      persona: "remote",
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
      dedupeKey: "dk-2",
      url: "https://example.com/2",
      sourceId: source.id,
      title: "Backend Engineer",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      aliases: [],
      raw: {},
    });

    await new Promise((r) => setTimeout(r, 5));

    const second = await repo.upsertByDedupeKey({
      dedupeKey: "dk-2",
      url: "https://example.com/2",
      sourceId: source.id,
      title: "Backend Engineer (updated)",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      aliases: [{ sourceId: "jobstreet", url: "https://jobstreet.com/2" }],
      raw: {},
    });

    expect(second.id).toBe(first.id);
    expect(second.firstSeenAt.getTime()).toBe(first.firstSeenAt.getTime());
    expect(second.lastSeenAt.getTime()).toBeGreaterThan(first.lastSeenAt.getTime());
    expect(second.aliases).toEqual([{ sourceId: "jobstreet", url: "https://jobstreet.com/2" }]);
  });

  it("listScored filters by tier + minScore and pages with a cursor", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);

    const rows: { jobId: string }[] = [];
    for (let i = 0; i < 3; i += 1) {
      const job = await repo.upsertByDedupeKey({
        dedupeKey: `dk-tier-${i}`,
        url: `https://example.com/tier-${i}`,
        sourceId: source.id,
        title: `Job ${i}`,
        company: "Acme",
        location: "Remote",
        persona: "remote",
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

  it("getById returns the joined job+score", async () => {
    const db = await createTestDb();
    const repo = createJobsRepo(db);
    const source = await insertSource(db);
    const resume = await insertResume(db);
    const job = await repo.upsertByDedupeKey({
      dedupeKey: "dk-single",
      url: "https://example.com/single",
      sourceId: source.id,
      title: "Job Single",
      company: "Acme",
      location: "Remote",
      persona: "remote",
      aliases: [],
      raw: {},
    });
    await insertJobScore(db, job.id, resume.id);

    const found = await repo.getById(job.id);
    expect(found?.job.id).toBe(job.id);
    expect(found?.score.jobId).toBe(job.id);
  });
});
