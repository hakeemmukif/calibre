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
      // jobs.persona is TEXT with no DB-level CHECK — the enum widening to
      // admit "pasted" is Task 4's schema.ts change, not landed yet.
      persona: "pasted" as unknown as "remote" | "local",
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
