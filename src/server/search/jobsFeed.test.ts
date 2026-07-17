import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { insertJob, insertProfile, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { jobs, jobScores, profile, resumes, searchRuns, sources } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

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
      userId: BOOTSTRAP_ADMIN_ID,
      resumeId: resume.id,
      personas: ["remote"],
      status: "completed",
      stats: { scanned: 0, matched: 0, scored: 0, worth: 0, ghosts: 0, perSource: [] },
      finishedAt: new Date(),
    });

    expect(await resolveIsNewCutoff(BOOTSTRAP_ADMIN_ID, "pasted")).toBeNull();
    // Existing scan personas are untouched by the pasted short-circuit.
    expect(await resolveIsNewCutoff(BOOTSTRAP_ADMIN_ID, "remote")).not.toBeNull();
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

    const remoteScope = await listJobsFeed({ persona: "remote" }, BOOTSTRAP_ADMIN_ID);
    expect(remoteScope.items).toHaveLength(0);
    expect(remoteScope.stats.excluded).toBe(1);

    const pastedScope = await listJobsFeed({ persona: "pasted" }, BOOTSTRAP_ADMIN_ID);
    expect(pastedScope.items).toHaveLength(1);
    expect(pastedScope.items[0].id).toBe(abroadPasted.id);
    expect(pastedScope.stats.excluded).toBe(0);
  });
});

// DECISION A (operator, 2026-07-17, full soft rank — see
// docs/superpowers/plans/2026-07-17-global-postings-pool-build.md "DECISION
// A"): tz_band (scheduleFlex) and hiring_structure (employmentPref) used to
// HARD-GATE the feed (jobsFeed.ts:68-69, pre-fix) — a misaligned job was
// filtered out of `listScored`/`statsForQuery` entirely and counted in
// `stats.excluded`. They now only demote rank; relocation/eligibility
// (STAY_TIERS) remains the sole hard gate.
describe("listJobsFeed — DECISION A demote-not-hide (tz_band/hiring_structure, 2026-07-17)", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  afterEach(async () => {
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(sources);
    await state.testDb.delete(resumes);
    await state.testDb.delete(profile);
  });

  it("a scheduleFlex/tz-misaligned job is NOT dropped from the feed — it appears, ranked below an aligned job", async () => {
    // "base-hours" admits only the "apac" band (allowedBandsFor) — a
    // stated "americas" job is the misaligned case.
    await insertProfile(state.testDb, { scheduleFlex: "base-hours" });
    const source = await insertSource(state.testDb);
    const resume = await insertResume(state.testDb);

    // Misaligned but firstSeenAt-NEWER — under plain recency ordering it
    // would sort first; demotion must override that ordering.
    const misaligned = await insertJob(state.testDb, source.id, {
      dedupeKey: "dk-tz-misaligned",
      url: "https://example.com/tz-misaligned",
      tzBand: "americas",
      firstSeenAt: new Date("2026-01-02T00:00:00Z"),
    });
    await insertJobScore(state.testDb, misaligned.id, resume.id);

    const aligned = await insertJob(state.testDb, source.id, {
      dedupeKey: "dk-tz-aligned",
      url: "https://example.com/tz-aligned",
      tzBand: "apac",
      firstSeenAt: new Date("2026-01-01T00:00:00Z"),
    });
    await insertJobScore(state.testDb, aligned.id, resume.id);

    const feed = await listJobsFeed({}, BOOTSTRAP_ADMIN_ID);
    const ids = feed.items.map((i) => i.id);

    expect(ids).toContain(misaligned.id); // not dropped
    expect(ids.indexOf(aligned.id)).toBeLessThan(ids.indexOf(misaligned.id)); // demotion is real
    expect(feed.stats.excluded).toBe(0); // no longer counted as hidden
  });

  it("an employmentPref/hiring_structure-misaligned job is NOT dropped from the feed — it appears, ranked below an aligned job", async () => {
    // "local-entity" admits only the "local-entity" structure
    // (allowedStructuresFor) — a stated "contractor" job is misaligned.
    await insertProfile(state.testDb, { employmentPref: "local-entity" });
    const source = await insertSource(state.testDb);
    const resume = await insertResume(state.testDb);

    const misaligned = await insertJob(state.testDb, source.id, {
      dedupeKey: "dk-structure-misaligned",
      url: "https://example.com/structure-misaligned",
      hiringStructure: "contractor",
      firstSeenAt: new Date("2026-01-02T00:00:00Z"),
    });
    await insertJobScore(state.testDb, misaligned.id, resume.id);

    const aligned = await insertJob(state.testDb, source.id, {
      dedupeKey: "dk-structure-aligned",
      url: "https://example.com/structure-aligned",
      hiringStructure: "local-entity",
      firstSeenAt: new Date("2026-01-01T00:00:00Z"),
    });
    await insertJobScore(state.testDb, aligned.id, resume.id);

    const feed = await listJobsFeed({}, BOOTSTRAP_ADMIN_ID);
    const ids = feed.items.map((i) => i.id);

    expect(ids).toContain(misaligned.id); // not dropped
    expect(ids.indexOf(aligned.id)).toBeLessThan(ids.indexOf(misaligned.id)); // demotion is real
    expect(feed.stats.excluded).toBe(0);
  });
});
