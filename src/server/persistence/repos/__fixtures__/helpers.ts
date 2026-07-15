// Minimal valid-row builders shared across repo tests — every column here is
// NOT NULL in schema.ts, so each helper fills the full shape once instead of
// every test file repeating it.
import { jobs, jobScores, profile, resumes, sources } from "../../schema";
import type { Db } from "../db";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export async function insertSource(db: Db, overrides: Partial<typeof sources.$inferInsert> = {}) {
  const [row] = await db
    .insert(sources)
    .values({
      id: unique("source"),
      name: "Test Source",
      kind: "ats",
      persona: "remote",
      enabled: true,
      // Matches the default kind "ats" — parseSourceGeo (spec §6) requires an
      // annotation on every real source; board overrides supply `country`.
      config: { geo: { scope: "restricted" } },
      ...overrides,
    })
    .returning();
  return row;
}

// A per-user profile row every startSearch/feed path requires (spec §4) —
// same shape seed.ts installs for the bootstrap admin.
export async function insertProfile(db: Db, overrides: Partial<typeof profile.$inferInsert> = {}) {
  const [row] = await db
    .insert(profile)
    .values({
      id: "default", userId: BOOTSTRAP_ADMIN_ID, baseCountry: "MY", relocation: "stay",
      scheduleFlex: "any-hours", employmentPref: "any",
      ...overrides,
    })
    .returning();
  return row;
}

export async function insertResume(db: Db, overrides: Partial<typeof resumes.$inferInsert> = {}) {
  const [row] = await db
    .insert(resumes)
    .values({
      userId: BOOTSTRAP_ADMIN_ID,
      rawText: "Jane Doe — Software Engineer",
      structured: {
        storeVersion: 2,
        extractionPath: "text",
        name: "Jane Doe",
        contact: [{ label: "email", value: "jane@example.com" }],
        summary: "Backend engineer.",
        experience: [],
        education: [],
        skills: [],
        projects: [],
        certifications: [],
        languages: [],
        sections: [],
      },
      sourceKind: "paste",
      isActive: false,
      ...overrides,
    })
    .returning();
  return row;
}

export async function insertJob(db: Db, sourceId: string, overrides: Partial<typeof jobs.$inferInsert> = {}) {
  const key = unique("job");
  const [row] = await db
    .insert(jobs)
    .values({
      userId: BOOTSTRAP_ADMIN_ID,
      dedupeKey: key,
      url: `https://example.com/${key}`,
      sourceId,
      title: "Senior Backend Engineer",
      company: "Example Co",
      location: "Remote",
      persona: "remote",
      eligibility: "unknown",
      eligibilityEvidence: "test fixture",
      aliases: [],
      raw: {},
      ...overrides,
    })
    .returning();
  return row;
}

export async function insertJobScore(
  db: Db,
  jobId: string,
  resumeId: string,
  overrides: Partial<typeof jobScores.$inferInsert> = {},
) {
  const [row] = await db
    .insert(jobScores)
    .values({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId,
      resumeId,
      score: 4.2,
      verdict: "Apply",
      why: "Strong overlap with recent backend experience.",
      legitimacy: { tier: "clear", tone: "good", summary: "Looks fine.", signals: [] },
      liveness: "active",
      breakdown: [],
      reasons: { for: [], against: [] },
      fit: [],
      gaps: [],
      jdFacts: {},
      model: "test-model",
      escalated: false,
      costUsd: 0.01,
      policyVersion: "v1",
      ...overrides,
    })
    .returning();
  return row;
}
