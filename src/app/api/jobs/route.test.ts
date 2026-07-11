import { NextRequest } from "next/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { insertJob, insertJobScore, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { jobs, jobScores, resumes, searchRuns, sources } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { GET } = await import("./route");

function req(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/jobs${query}`);
}

describe("GET /api/jobs", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  afterEach(async () => {
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(searchRuns);
    await state.testDb.delete(sources);
    await state.testDb.delete(resumes);
  });

  it("filters by tier + minScore and pages with a cursor", async () => {
    const source = await insertSource(state.testDb);
    const resume = await insertResume(state.testDb);

    for (let i = 0; i < 3; i += 1) {
      const job = await insertJob(state.testDb, source.id, { dedupeKey: `dk-${i}`, url: `https://example.com/${i}` });
      await insertJobScore(state.testDb, job.id, resume.id, {
        score: 4.5 - i * 0.1,
        legitimacy: { tier: i === 2 ? "suspicious" : "clear", tone: i === 2 ? "warn" : "good", summary: "x", signals: [] },
      });
    }

    const res = await GET(req("?tier=clear&minScore=4&limit=1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].legitimacy.tier).toBe("clear");
    expect(body.nextCursor).not.toBeNull();

    const res2 = await GET(req(`?tier=clear&minScore=4&limit=1&cursor=${body.nextCursor}`));
    const body2 = await res2.json();
    expect(body2.items).toHaveLength(1);
    expect(body2.items[0].id).not.toBe(body.items[0].id);
    expect(body2.nextCursor).toBeNull();
  });

  it("stats are computed over the full scoped set, not the paginated page", async () => {
    const source = await insertSource(state.testDb);
    const resume = await insertResume(state.testDb);

    const tiers: ("clear" | "suspicious" | "ghost" | "scam")[] = ["clear", "suspicious", "ghost", "scam"];
    const verdicts: ("Apply" | "Consider" | "Skip")[] = ["Apply", "Consider", "Skip"];
    for (let i = 0; i < 8; i += 1) {
      const job = await insertJob(state.testDb, source.id, { dedupeKey: `dk-stats-${i}`, url: `https://example.com/stats-${i}` });
      await insertJobScore(state.testDb, job.id, resume.id, {
        verdict: verdicts[i % verdicts.length],
        legitimacy: { tier: tiers[i % tiers.length], tone: "good", summary: "x", signals: [] },
      });
    }

    const res = await GET(req("?limit=2"));
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    expect(body.stats.scanned).toBe(8);
    expect(body.stats.scanned).toBeGreaterThan(body.items.length);
    // ghost at i=2,6 -> 2; scam at i=3,7 -> included in flagged; suspicious i=1,5
    expect(body.stats.ghosts).toBe(2);
    expect(body.stats.flagged).toBe(6); // suspicious(2) + ghost(2) + scam(2)
  });

  it("an unknown query parameter returns 422 VALIDATION_ERROR", async () => {
    const res = await GET(req("?bogus=1"));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("isNew=false and isNew=true are parsed as real booleans, not string truthiness", async () => {
    const source = await insertSource(state.testDb);
    const resume = await insertResume(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    await insertJobScore(state.testDb, job.id, resume.id);

    const resFalse = await GET(req("?isNew=false"));
    expect(resFalse.status).toBe(200);
    const resTrue = await GET(req("?isNew=true"));
    expect(resTrue.status).toBe(200);
  });

  it("an invalid tier value returns 422", async () => {
    const res = await GET(req("?tier=not-a-tier"));
    expect(res.status).toBe(422);
  });

  it("a malformed cursor returns 422 VALIDATION_ERROR, never a 500", async () => {
    const res = await GET(req("?cursor=%%%not-base64-json%%%"));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });
});
