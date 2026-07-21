import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { postings } from "../schema";
import type { Db } from "./db";
import { insertSource } from "./__fixtures__/helpers";
import { createPoolStatsRepo } from "./poolStats";

let counter = 0;
async function insertPosting(db: Db, sourceId: string, overrides: Partial<typeof postings.$inferInsert> = {}) {
  counter += 1;
  const key = `ck-pool-${counter}`;
  const [row] = await db
    .insert(postings)
    .values({
      canonicalKey: key,
      url: `https://example.com/${key}`,
      sourceId,
      title: "Senior Backend Engineer",
      company: "Example Co",
      location: "Remote",
      persona: "remote",
      aliases: [],
      raw: {},
      ...overrides,
    })
    .returning();
  return row;
}

function pctExpect(count: number, total: number): number {
  return total === 0 ? 0 : Math.round((count / total) * 1000) / 10;
}

const NOW = new Date("2026-07-21T00:00:00.000Z").getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

describe("poolStatsRepo.getPoolStats", () => {
  it("aggregates totals, source coverage, function mix (hybrid rule), tz bands, freshness, concentration", async () => {
    const db = await createTestDb();
    const repo = createPoolStatsRepo(db);
    const enabledSource = await insertSource(db, { enabled: true });
    const disabledSource = await insertSource(db, { enabled: false });

    // Tagged row — functionTag wins over any keyword guess from the title.
    await insertPosting(db, enabledSource.id, {
      title: "Mystery Role",
      company: "Acme",
      functionTag: "engineering",
      tzBand: "americas",
      firstSeenAt: new Date(NOW - 2 * 60 * 60 * 1000), // 2h ago
    });
    // Untagged row — falls back to the keyword bucket on title.
    await insertPosting(db, enabledSource.id, {
      title: "Data Analyst",
      company: "Acme",
      tzBand: null,
      firstSeenAt: new Date(NOW - 3 * DAY_MS), // 3 days ago
    });
    await insertPosting(db, disabledSource.id, {
      title: "Warehouse Associate",
      company: "Globex",
      tzBand: "emea",
      firstSeenAt: new Date(NOW - 40 * DAY_MS), // older
    });
    // Delisted — excluded from every live aggregate.
    await insertPosting(db, enabledSource.id, {
      title: "Ghost Listing",
      company: "Globex",
      delistedAt: new Date(NOW),
      firstSeenAt: new Date(NOW),
    });

    const stats = await repo.getPoolStats(NOW);

    expect(stats.totals).toEqual({
      live: 3,
      delisted: 1,
      newLast24h: 1,
      sourcesEnabled: 1,
      sourcesTotal: 2,
      tagCoveragePct: pctExpect(1, 3),
    });

    expect(stats.functionMix).toHaveLength(12);
    expect(stats.functionMix.find((m) => m.bucket === "engineering")).toEqual({
      bucket: "engineering", count: 1, share: pctExpect(1, 3), source: "tag",
    });
    expect(stats.functionMix.find((m) => m.bucket === "data")).toEqual({
      bucket: "data", count: 1, share: pctExpect(1, 3), source: "keyword",
    });
    expect(stats.functionMix.find((m) => m.bucket === "other")).toEqual({
      bucket: "other", count: 1, share: pctExpect(1, 3), source: "keyword",
    });

    expect(stats.tzBands).toEqual([
      { band: "americas", count: 1, share: pctExpect(1, 3) },
      { band: "emea", count: 1, share: pctExpect(1, 3) },
      { band: "apac", count: 0, share: 0 },
      { band: "worldwide", count: 0, share: 0 },
      { band: "unassigned", count: 1, share: pctExpect(1, 3) },
    ]);

    expect(stats.freshness).toEqual([
      { bucket: "24h", count: 1 },
      { bucket: "2-7d", count: 1 },
      { bucket: "8-30d", count: 0 },
      { bucket: "older", count: 1 },
    ]);

    expect(stats.concentration.topCompanies).toEqual([
      { company: "Acme", count: 2 },
      { company: "Globex", count: 1 },
    ]);
    expect(stats.concentration.top10Count).toBe(3);
    expect(stats.concentration.restCount).toBe(0);

    // Invariant: every live row lands in exactly one functionMix bucket —
    // a raw/unmapped tag value must never silently vanish from the sum.
    const totalMixCount = stats.functionMix.reduce((sum, m) => sum + m.count, 0);
    expect(totalMixCount).toBe(stats.totals.live);
  });

  it("folds a junk tz_band value into 'unassigned' instead of vanishing from tzBands (MINOR-4)", async () => {
    const db = await createTestDb();
    const repo = createPoolStatsRepo(db);
    const source = await insertSource(db, { enabled: true });

    // tzBand is TS-enum-constrained ("apac"|"emea"|"americas"|"worldwide") but
    // SQLite enforces no CHECK — a junk value can still land in the column
    // (bad data drift, manual edit) and must not silently vanish from tzBands.
    await insertPosting(db, source.id, { title: "Backend Engineer", tzBand: "moon-base" as "americas" });
    await insertPosting(db, source.id, { title: "Sales Rep", tzBand: "americas" });
    await insertPosting(db, source.id, { title: "Support Rep", tzBand: null });
    // A real "worldwide" value must count as its OWN band, never fold into
    // 'unassigned' alongside the junk value above.
    await insertPosting(db, source.id, { title: "Remote Anywhere Engineer", tzBand: "worldwide" });

    const stats = await repo.getPoolStats(NOW);

    expect(stats.tzBands.find((b) => b.band === "unassigned")).toMatchObject({ count: 2 });
    expect(stats.tzBands.find((b) => b.band === "americas")).toMatchObject({ count: 1 });
    expect(stats.tzBands.find((b) => b.band === "worldwide")).toMatchObject({ count: 1 });

    const totalTzCount = stats.tzBands.reduce((sum, b) => sum + b.count, 0);
    expect(totalTzCount).toBe(stats.totals.live);
  });

  it("resolves the 6 P.4 tags whose spelling diverges from a bucket id via TAG_TO_BUCKET, source 'tag'", async () => {
    const db = await createTestDb();
    const repo = createPoolStatsRepo(db);
    const source = await insertSource(db, { enabled: true });

    await insertPosting(db, source.id, { title: "Support Rep", functionTag: "customer-success" });
    await insertPosting(db, source.id, { title: "Recruiter", functionTag: "people" });
    await insertPosting(db, source.id, { title: "Controller", functionTag: "finance" });
    await insertPosting(db, source.id, { title: "Paralegal", functionTag: "legal" });
    await insertPosting(db, source.id, { title: "Ops Coordinator", functionTag: "operations" });
    await insertPosting(db, source.id, { title: "COO", functionTag: "executive" });

    const stats = await repo.getPoolStats(NOW);

    expect(stats.functionMix.find((m) => m.bucket === "cs_support")).toMatchObject({ count: 1, source: "tag" });
    expect(stats.functionMix.find((m) => m.bucket === "people_hr")).toMatchObject({ count: 1, source: "tag" });
    // `finance` and `legal` both fold into `finance_legal` — count 2.
    expect(stats.functionMix.find((m) => m.bucket === "finance_legal")).toMatchObject({ count: 2, source: "tag" });
    expect(stats.functionMix.find((m) => m.bucket === "ops_admin")).toMatchObject({ count: 1, source: "tag" });
    expect(stats.functionMix.find((m) => m.bucket === "leadership")).toMatchObject({ count: 1, source: "tag" });

    const totalMixCount = stats.functionMix.reduce((sum, m) => sum + m.count, 0);
    expect(totalMixCount).toBe(stats.totals.live);
  });

  it("throws on an unknown non-empty function_tag (fail-loud, never silently dropped)", async () => {
    const db = await createTestDb();
    const repo = createPoolStatsRepo(db);
    const source = await insertSource(db, { enabled: true });
    await insertPosting(db, source.id, { title: "Whatever", functionTag: "gardening" });

    await expect(repo.getPoolStats(NOW)).rejects.toThrow(/unknown function_tag "gardening"/);
  });

  it("treats an empty-string function_tag as absent — falls back to the keyword bucket on title", async () => {
    const db = await createTestDb();
    const repo = createPoolStatsRepo(db);
    const source = await insertSource(db, { enabled: true });
    await insertPosting(db, source.id, { title: "UX Designer", functionTag: "" });

    const stats = await repo.getPoolStats(NOW);

    expect(stats.functionMix.find((m) => m.bucket === "design")).toMatchObject({ count: 1, source: "keyword" });
  });
});
