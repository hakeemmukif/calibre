import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { insertJob, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { jobs, resumes, sources, tailoredResumes } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { computeAtsScore } from "@/server/resume/atsScore";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { finalizeTailor, RunNotReadyError } = await import("./index");
const { tailoredResumesRepo } = await import("@/server/persistence/repos/tailoredResumes");

const BASE_STORE = {
  name: "Jane Doe",
  contact: [
    { label: "email", value: "jane@example.com" },
    { label: "location", value: "Kuala Lumpur, Malaysia" },
  ],
  summary: "Backend engineer.",
  experience: [
    { company: "Acme Corp", title: "Backend Engineer", dates: "2020–Present", bullets: ["Built internal tools"] },
  ],
  education: [],
  skills: [{ label: "Languages", items: ["TypeScript"] }],
  extras: [],
};

const TAILORED_STORE = {
  ...BASE_STORE,
  summary: "Backend engineer specializing in payments infrastructure.",
  skills: [{ label: "Languages", items: ["TypeScript", "Go"] }],
  extras: ["Speaks English and Malay"],
};

const DIFF = [
  { section: "summary", op: "modify" as const, before: BASE_STORE.summary, after: TAILORED_STORE.summary, reason: "emphasize payments" },
  { section: "skills", op: "modify" as const, before: "TypeScript", after: "TypeScript, Go", reason: "surface Go experience" },
  { section: "extras", op: "add" as const, after: "Speaks English and Malay", reason: "language requirement in JD" },
];

describe("finalizeTailor", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  afterEach(async () => {
    await state.testDb.delete(tailoredResumes);
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

    await expect(finalizeTailor(draft.id, [])).rejects.toBeInstanceOf(RunNotReadyError);
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
    const result = await finalizeTailor(draft.id, [0]);

    expect(result.resume?.summary).toBe(TAILORED_STORE.summary);
    expect(result.resume?.skills).toEqual(["TypeScript"]); // base skills, not tailored's ["TypeScript","Go"]
    expect(result.resume?.atsScore).toBe(computeAtsScore({ ...BASE_STORE, summary: TAILORED_STORE.summary }));

    const row = await tailoredResumesRepo.getById(draft.id);
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
    const first = await finalizeTailor(draft.id, [0]);
    expect(first.resume?.summary).toBe(TAILORED_STORE.summary);
    expect(first.resume?.skills).toEqual(["TypeScript"]); // base skills — not accepted this round

    // Re-finalize: the user changes their mind — accept skills (index 1)
    // instead, reject summary this time. If `structured` had been destroyed
    // by the first finalize, skills' tailored value would be unrecoverable.
    const second = await finalizeTailor(draft.id, [1]);
    expect(second.resume?.summary).toBe(BASE_STORE.summary); // summary reverted — no longer accepted
    expect(second.resume?.skills).toEqual(["TypeScript", "Go"]); // skills' tailored change recovered

    const row = await tailoredResumesRepo.getById(draft.id);
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

    const result = await finalizeTailor(draft.id, [0, 1, 2]);
    expect(result.resume?.skills).toEqual(["TypeScript", "Go"]);
  });
});
