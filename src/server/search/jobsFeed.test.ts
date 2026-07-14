import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { insertJob, insertProfile, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { jobs, jobScores, profile, resumes, searchRuns, sources } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { resolveIsNewCutoff, listJobsFeed } = await import("./jobsFeed");
const { insertJobScore } = await import("@/server/persistence/repos/__fixtures__/helpers");

describe("resolveIsNewCutoff", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  afterEach(async () => {
    await state.testDb.delete(searchRuns);
    await state.testDb.delete(resumes);
  });

  it("returns null for persona 'pasted' without touching search_runs (spec §11.4)", async () => {
    const resume = await insertResume(state.testDb);
    await state.testDb.insert(searchRuns).values({
      resumeId: resume.id,
      personas: ["remote"],
      status: "completed",
      stats: { scanned: 0, matched: 0, scored: 0, worth: 0, ghosts: 0, perSource: [] },
      finishedAt: new Date(),
    });

    expect(await resolveIsNewCutoff("pasted")).toBeNull();
    // Existing scan personas are untouched by the pasted short-circuit.
    expect(await resolveIsNewCutoff("remote")).not.toBeNull();
  });
});

describe("listJobsFeed — Pasted scope eligibility predicate skip (spec §2.12)", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
    await insertProfile(state.testDb); // relocation "stay" — the seeded default
  });

  afterEach(async () => {
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(sources);
    await state.testDb.delete(resumes);
  });

  it("an abroad job is hidden in the Remote scope but visible (and uncounted) in the Pasted scope", async () => {
    const source = await insertSource(state.testDb);
    const resume = await insertResume(state.testDb);

    const abroadRemote = await insertJob(state.testDb, source.id, {
      dedupeKey: "dk-abroad-remote",
      url: "https://example.com/abroad-remote",
      persona: "remote",
      eligibility: "abroad",
      eligibilityEvidence: "location: New York, NY",
    });
    await insertJobScore(state.testDb, abroadRemote.id, resume.id);

    const abroadPasted = await insertJob(state.testDb, source.id, {
      dedupeKey: "dk-abroad-pasted",
      url: "https://example.com/abroad-pasted",
      persona: "pasted",
      eligibility: "abroad",
      eligibilityEvidence: "location: New York, NY",
    });
    await insertJobScore(state.testDb, abroadPasted.id, resume.id);

    const remoteScope = await listJobsFeed({ persona: "remote" });
    expect(remoteScope.items).toHaveLength(0);
    expect(remoteScope.stats.excluded).toBe(1);

    const pastedScope = await listJobsFeed({ persona: "pasted" });
    expect(pastedScope.items).toHaveLength(1);
    expect(pastedScope.items[0].id).toBe(abroadPasted.id);
    expect(pastedScope.stats.excluded).toBe(0);
  });
});

describe("listJobsFeed — schedule gate (spec §7)", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
    await insertProfile(state.testDb, { scheduleFlex: "base-hours" });
  });

  afterEach(async () => {
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(sources);
    await state.testDb.delete(resumes);
  });

  it("hides an americas-band job, keeps apac and NULL-band jobs, counts the hidden one in excluded", async () => {
    const source = await insertSource(state.testDb);
    const resume = await insertResume(state.testDb);

    const americas = await insertJob(state.testDb, source.id, {
      dedupeKey: "dk-tz-americas",
      url: "https://example.com/tz-americas",
      persona: "remote",
      eligibility: "anywhere",
      tzBand: "americas",
    });
    await insertJobScore(state.testDb, americas.id, resume.id);

    const apac = await insertJob(state.testDb, source.id, {
      dedupeKey: "dk-tz-apac",
      url: "https://example.com/tz-apac",
      persona: "remote",
      eligibility: "anywhere",
      tzBand: "apac",
    });
    await insertJobScore(state.testDb, apac.id, resume.id);

    const nullBand = await insertJob(state.testDb, source.id, {
      dedupeKey: "dk-tz-null",
      url: "https://example.com/tz-null",
      persona: "remote",
      eligibility: "anywhere",
      tzBand: null,
    });
    await insertJobScore(state.testDb, nullBand.id, resume.id);

    const feed = await listJobsFeed({ persona: "remote" });
    const ids = feed.items.map((i) => i.id);
    expect(ids).not.toContain(americas.id);
    expect(ids).toContain(apac.id);
    expect(ids).toContain(nullBand.id);
    expect(feed.stats.excluded).toBe(1);
  });
});

describe("listJobsFeed — structure gate (spec §7)", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
    await insertProfile(state.testDb, { employmentPref: "employee" });
  });

  afterEach(async () => {
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(sources);
    await state.testDb.delete(resumes);
  });

  it("hides a contractor job, keeps eor/local-entity/NULL, counts the hidden one in excluded", async () => {
    const source = await insertSource(state.testDb);
    const resume = await insertResume(state.testDb);

    const contractor = await insertJob(state.testDb, source.id, {
      dedupeKey: "dk-struct-contractor",
      url: "https://example.com/struct-contractor",
      persona: "remote",
      eligibility: "anywhere",
      hiringStructure: "contractor",
    });
    await insertJobScore(state.testDb, contractor.id, resume.id);

    const eor = await insertJob(state.testDb, source.id, {
      dedupeKey: "dk-struct-eor",
      url: "https://example.com/struct-eor",
      persona: "remote",
      eligibility: "anywhere",
      hiringStructure: "eor",
    });
    await insertJobScore(state.testDb, eor.id, resume.id);

    const localEntity = await insertJob(state.testDb, source.id, {
      dedupeKey: "dk-struct-local-entity",
      url: "https://example.com/struct-local-entity",
      persona: "remote",
      eligibility: "anywhere",
      hiringStructure: "local-entity",
    });
    await insertJobScore(state.testDb, localEntity.id, resume.id);

    const nullStructure = await insertJob(state.testDb, source.id, {
      dedupeKey: "dk-struct-null",
      url: "https://example.com/struct-null",
      persona: "remote",
      eligibility: "anywhere",
      hiringStructure: null,
    });
    await insertJobScore(state.testDb, nullStructure.id, resume.id);

    const feed = await listJobsFeed({ persona: "remote" });
    const ids = feed.items.map((i) => i.id);
    expect(ids).not.toContain(contractor.id);
    expect(ids).toContain(eor.id);
    expect(ids).toContain(localEntity.id);
    expect(ids).toContain(nullStructure.id);
    expect(feed.stats.excluded).toBe(1);
  });
});

describe("listJobsFeed — Pasted scope exempt from schedule/structure gates (spec §7, §2.12)", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
    await insertProfile(state.testDb, { scheduleFlex: "base-hours", employmentPref: "employee" });
  });

  afterEach(async () => {
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(sources);
    await state.testDb.delete(resumes);
  });

  it("shows a pasted americas-band contractor job despite restrictive dials, excluded stays 0", async () => {
    const source = await insertSource(state.testDb);
    const resume = await insertResume(state.testDb);

    const job = await insertJob(state.testDb, source.id, {
      dedupeKey: "dk-pasted-restrictive",
      url: "https://example.com/pasted-restrictive",
      persona: "pasted",
      eligibility: "abroad",
      tzBand: "americas",
      hiringStructure: "contractor",
    });
    await insertJobScore(state.testDb, job.id, resume.id);

    const feed = await listJobsFeed({ persona: "pasted" });
    expect(feed.items.map((i) => i.id)).toContain(job.id);
    expect(feed.stats.excluded).toBe(0);
  });
});

describe("listJobsFeed — a job hidden by multiple gates counts once in excluded (spec §7)", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
    await insertProfile(state.testDb, { relocation: "stay", scheduleFlex: "base-hours" });
  });

  afterEach(async () => {
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(sources);
    await state.testDb.delete(resumes);
  });

  it("a job that's both abroad and americas-band is hidden and excluded exactly once", async () => {
    const source = await insertSource(state.testDb);
    const resume = await insertResume(state.testDb);

    const job = await insertJob(state.testDb, source.id, {
      dedupeKey: "dk-double-hidden",
      url: "https://example.com/double-hidden",
      persona: "remote",
      eligibility: "abroad",
      tzBand: "americas",
    });
    await insertJobScore(state.testDb, job.id, resume.id);

    const feed = await listJobsFeed({ persona: "remote" });
    expect(feed.items.map((i) => i.id)).not.toContain(job.id);
    expect(feed.stats.excluded).toBe(1);
  });
});

describe("listJobsFeed — permissive dials no-op (spec §7 regression)", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
    await insertProfile(state.testDb); // any-hours + any — the seeded permissive default
  });

  afterEach(async () => {
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(sources);
    await state.testDb.delete(resumes);
  });

  it("stated tzBand/hiringStructure facts are never hidden when dials are fully permissive", async () => {
    const source = await insertSource(state.testDb);
    const resume = await insertResume(state.testDb);

    const americas = await insertJob(state.testDb, source.id, {
      dedupeKey: "dk-permissive-americas",
      url: "https://example.com/permissive-americas",
      persona: "remote",
      eligibility: "anywhere",
      tzBand: "americas",
    });
    await insertJobScore(state.testDb, americas.id, resume.id);

    const contractor = await insertJob(state.testDb, source.id, {
      dedupeKey: "dk-permissive-contractor",
      url: "https://example.com/permissive-contractor",
      persona: "remote",
      eligibility: "anywhere",
      hiringStructure: "contractor",
    });
    await insertJobScore(state.testDb, contractor.id, resume.id);

    const feed = await listJobsFeed({ persona: "remote" });
    const ids = feed.items.map((i) => i.id);
    expect(ids).toContain(americas.id);
    expect(ids).toContain(contractor.id);
    expect(feed.stats.excluded).toBe(0);
  });
});
