import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { insertJob, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { correlationReports, jobs, resumes, sources, tailoredResumes, users } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { computeAtsScore } from "@/server/resume/atsScore";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";
import type { TailorDiffEntry } from "@/types";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { finalizeTailor, RunNotReadyError, UnknownTailorIdError } = await import("./index");
const { tailoredResumesRepo } = await import("@/server/persistence/repos/tailoredResumes");
const { correlationReportsRepo } = await import("@/server/persistence/repos/correlationReports");

const BASE_STORE = {
  storeVersion: 2 as const,
  extractionPath: "text" as const,
  name: "Jane Doe",
  contact: [
    { label: "email", value: "jane@example.com" },
    { label: "location", value: "Kuala Lumpur, Malaysia" },
  ],
  summary: "Backend engineer.",
  experience: [
    { company: "Acme Corp", title: "Backend Engineer", dates: "2020–Present", isCurrent: true, bullets: ["Built internal tools"] },
  ],
  education: [],
  skills: [{ label: "Languages", items: ["TypeScript"] }],
  projects: [],
  certifications: [],
  languages: [],
  sections: [],
};

const TAILORED_STORE = {
  ...BASE_STORE,
  summary: "Backend engineer specializing in payments infrastructure.",
  skills: [{ label: "Languages", items: ["TypeScript", "Go"] }],
};

const DIFF: TailorDiffEntry[] = [
  {
    section: "summary", op: "modify", before: BASE_STORE.summary, after: TAILORED_STORE.summary,
    reason: "emphasize payments", requirement: "payments infrastructure experience",
    target: { index: null, bulletIndex: null },
  },
  {
    section: "skills", op: "add", after: "Go",
    reason: "surface Go experience", requirement: "Go experience",
    target: { index: 0, bulletIndex: null },
  },
];

describe("finalizeTailor", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  afterEach(async () => {
    await state.testDb.delete(tailoredResumes);
    await state.testDb.delete(correlationReports);
    await state.testDb.delete(jobs);
    await state.testDb.delete(resumes);
    await state.testDb.delete(sources);
  });

  it("409 RUN_NOT_READY while the run has not completed", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true, structured: BASE_STORE });

    const draft = await tailoredResumesRepo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      baseResumeId: resume.id,
      diff: [],
      status: "queued",
      model: "openai/gpt-4.1",
    });

    await expect(finalizeTailor(draft.id, BOOTSTRAP_ADMIN_ID, [])).rejects.toBeInstanceOf(RunNotReadyError);
  });

  it("throws UnknownTailorIdError for a foreign-owned tailor run (no existence leak)", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true, structured: BASE_STORE });
    const [userB] = await state.testDb
      .insert(users)
      .values({ email: "user-b-finalizetailor@example.com", passwordHash: "h", role: "user" })
      .returning();

    const draft = await tailoredResumesRepo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      baseResumeId: resume.id,
      diff: [],
      status: "queued",
      model: "openai/gpt-4.1",
    });
    await tailoredResumesRepo.complete(draft.id, {
      structured: BASE_STORE,
      diff: [],
      model: "mock",
      costUsd: 0.01,
      completedAt: new Date(),
    });

    await expect(finalizeTailor(draft.id, userB.id, [])).rejects.toBeInstanceOf(UnknownTailorIdError);
  });

  it("applies only the accepted subset, recomputes atsScore, and sets finalizedAt", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true, structured: BASE_STORE });

    const draft = await tailoredResumesRepo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      baseResumeId: resume.id,
      diff: DIFF,
      status: "queued",
      model: "openai/gpt-4.1",
    });
    await tailoredResumesRepo.complete(draft.id, {
      structured: TAILORED_STORE,
      diff: DIFF,
      model: "mock",
      costUsd: 0.03,
      completedAt: new Date(),
    });

    // Accept only the summary rewrite (index 0) — reject skills (1) and
    // extras (2): the merged store must keep BASE's skills/extras verbatim.
    const result = await finalizeTailor(draft.id, BOOTSTRAP_ADMIN_ID, [0]);

    expect(result.resume?.summary).toBe(TAILORED_STORE.summary);
    expect(result.resume?.skills).toEqual(["TypeScript"]); // base skills, not tailored's ["TypeScript","Go"]
    expect(result.resume?.atsScore).toBe(computeAtsScore({ ...BASE_STORE, summary: TAILORED_STORE.summary }));

    const row = await tailoredResumesRepo.getById(draft.id, BOOTSTRAP_ADMIN_ID);
    expect(row?.finalizedAt).not.toBeNull();
    expect(row?.acceptedIndices).toEqual([0]);
    // task-B8 review fix (Finding 2): `structured` is immutable — finalize
    // must NOT overwrite it with the accepted-only merge, or a later
    // re-finalize with a different accepted set would have no way to
    // recover the rejected sections.
    expect(row?.structured).toEqual(TAILORED_STORE);
  });

  it("re-finalize with a different accepted set is non-destructive (Finding 2): the second finalize correctly reflects the newly-accepted section, and the previously-accepted one is now absent", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true, structured: BASE_STORE });

    const draft = await tailoredResumesRepo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      baseResumeId: resume.id,
      diff: DIFF,
      status: "queued",
      model: "openai/gpt-4.1",
    });
    await tailoredResumesRepo.complete(draft.id, {
      structured: TAILORED_STORE,
      diff: DIFF,
      model: "mock",
      costUsd: 0.03,
      completedAt: new Date(),
    });

    // First finalize: accept only the summary rewrite (index 0).
    const first = await finalizeTailor(draft.id, BOOTSTRAP_ADMIN_ID, [0]);
    expect(first.resume?.summary).toBe(TAILORED_STORE.summary);
    expect(first.resume?.skills).toEqual(["TypeScript"]); // base skills — not accepted this round

    // Re-finalize: the user changes their mind — accept skills (index 1)
    // instead, reject summary this time. If `structured` had been destroyed
    // by the first finalize, skills' tailored value would be unrecoverable.
    const second = await finalizeTailor(draft.id, BOOTSTRAP_ADMIN_ID, [1]);
    expect(second.resume?.summary).toBe(BASE_STORE.summary); // summary reverted — no longer accepted
    expect(second.resume?.skills).toEqual(["TypeScript", "Go"]); // skills' tailored change recovered

    const row = await tailoredResumesRepo.getById(draft.id, BOOTSTRAP_ADMIN_ID);
    expect(row?.acceptedIndices).toEqual([1]);
    expect(row?.structured).toEqual(TAILORED_STORE); // still immutable
  });

  it("accepting every index yields the fully tailored resume view", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true, structured: BASE_STORE });

    const draft = await tailoredResumesRepo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      baseResumeId: resume.id,
      diff: DIFF,
      status: "queued",
      model: "openai/gpt-4.1",
    });
    await tailoredResumesRepo.complete(draft.id, {
      structured: TAILORED_STORE,
      diff: DIFF,
      model: "mock",
      costUsd: 0.03,
      completedAt: new Date(),
    });

    const result = await finalizeTailor(draft.id, BOOTSTRAP_ADMIN_ID, [0, 1]);
    expect(result.resume?.skills).toEqual(["TypeScript", "Go"]);
  });

  it("computes and persists atsDelta from the linked report's ats signal and the accepted merge", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true, structured: BASE_STORE });

    const report = await correlationReportsRepo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      resumeId: resume.id,
      rows: [],
      status: "queued",
      model: "openai/gpt-4.1",
    });
    await correlationReportsRepo.complete(report.id, {
      rows: [
        { requirement: "TypeScript experience", term: "TypeScript", kind: "must", status: "met", evidence: "TypeScript", atsPresent: true, reason: "r", note: null },
        { requirement: "Go experience", term: "Go", kind: "nice", status: "gap", evidence: null, atsPresent: false, reason: "r", note: null },
      ],
      semantic: { met: 1, buried: 0, gap: 1, total: 2 },
      ats: { present: 1, total: 2, missing: ["Go"] },
      model: "mock",
      costUsd: 0.01,
      completedAt: new Date(),
    });

    const draft = await tailoredResumesRepo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      baseResumeId: resume.id,
      reportId: report.id,
      diff: DIFF,
      status: "queued",
      model: "openai/gpt-4.1",
    });
    await tailoredResumesRepo.complete(draft.id, {
      structured: TAILORED_STORE,
      diff: DIFF,
      model: "mock",
      costUsd: 0.03,
      completedAt: new Date(),
      reportId: report.id,
    });

    // Accept only the skills "add Go" edit (index 1) — DIFF[0] (summary)
    // doesn't touch either report term, so it's the +1 "Go" bullet that
    // moves ATS presence from 1/2 to 2/2.
    const result = await finalizeTailor(draft.id, BOOTSTRAP_ADMIN_ID, [1]);
    expect(result.atsDelta).toEqual({ before: 1, after: 2, total: 2 });

    const row = await tailoredResumesRepo.getById(draft.id, BOOTSTRAP_ADMIN_ID);
    expect(row?.atsDelta).toEqual({ before: 1, after: 2, total: 2 });
  });

  it("atsDelta is null for a tailored résumé with no linked report", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true, structured: BASE_STORE });

    const draft = await tailoredResumesRepo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId: job.id,
      baseResumeId: resume.id,
      diff: DIFF,
      status: "queued",
      model: "openai/gpt-4.1",
    });
    await tailoredResumesRepo.complete(draft.id, {
      structured: TAILORED_STORE,
      diff: DIFF,
      model: "mock",
      costUsd: 0.03,
      completedAt: new Date(),
    });

    const result = await finalizeTailor(draft.id, BOOTSTRAP_ADMIN_ID, [0]);
    expect(result.atsDelta).toBeNull();

    const row = await tailoredResumesRepo.getById(draft.id, BOOTSTRAP_ADMIN_ID);
    expect(row?.atsDelta).toBeNull();
  });
});
