import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeMockLlm } from "@/lib/llm/mock";
import { insertJob, insertJobScore, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { jobs, jobScores, resumes, sources, tailoredResumes, users } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { startTailor, UnknownJobError, NoActiveResumeError } = await import("./index");
const { tailoredResumesRepo } = await import("@/server/persistence/repos/tailoredResumes");
const { get: getRunHandle, __resetForTests } = await import("@/server/runs/registry");

const TAILORED_STORE = {
  storeVersion: 2,
  extractionPath: "text",
  name: "Jane Doe",
  contact: [
    { label: "email", value: "jane@example.com" },
    { label: "location", value: "Kuala Lumpur, Malaysia" },
  ],
  summary: "Backend engineer, now framed around payments infra.",
  experience: [
    { company: "Acme Corp", title: "Senior Backend Engineer", dates: "2020–Present", isCurrent: true, bullets: ["Led the payments API rewrite"] },
  ],
  education: [],
  skills: [{ label: "Languages", items: ["TypeScript", "Go"] }],
  projects: [],
  certifications: [],
  languages: [],
  sections: [],
};

const TAILOR_DIFF = [
  { section: "summary", op: "modify" as const, before: "Backend engineer.", after: TAILORED_STORE.summary, reason: "emphasize payments overlap" },
];

async function waitForTerminal(id: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await tailoredResumesRepo.getById(id, BOOTSTRAP_ADMIN_ID);
    if (row && (row.status === "completed" || row.status === "failed")) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`tailor run ${id} did not reach a terminal state within the test timeout`);
}

describe("startTailor", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  afterEach(async () => {
    __resetForTests();
    await state.testDb.delete(tailoredResumes);
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(resumes);
    await state.testDb.delete(sources);
  });

  it("404s (UnknownJobError) for an unknown job id", async () => {
    await expect(startTailor(BOOTSTRAP_ADMIN_ID, { jobId: crypto.randomUUID() })).rejects.toBeInstanceOf(UnknownJobError);
  });

  it("404s (UnknownJobError) for a foreign-owned job id (no existence leak)", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const [userB] = await state.testDb
      .insert(users)
      .values({ email: "user-b-starttailor@example.com", passwordHash: "h", role: "user" })
      .returning();

    await expect(startTailor(userB.id, { jobId: job.id })).rejects.toBeInstanceOf(UnknownJobError);
  });

  it("409s (NoActiveResumeError) when no résumé is active", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    await expect(startTailor(BOOTSTRAP_ADMIN_ID, { jobId: job.id })).rejects.toBeInstanceOf(NoActiveResumeError);
  });

  it("returns a queued draft immediately, then completes async with structured + diff", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true });
    await insertJobScore(state.testDb, job.id, resume.id, {
      jdFacts: { title: "Backend Engineer", mustHaves: ["payments"], niceToHaves: [], responsibilities: [], redFlags: [] },
      gaps: [{ tone: "warn", k: "payments", v: "No direct payments experience listed" }],
    });

    const llm = makeMockLlm({ tailor: { resume: TAILORED_STORE, diff: TAILOR_DIFF } });

    const draft = await startTailor(BOOTSTRAP_ADMIN_ID, { jobId: job.id }, { llm });
    expect(draft.status).toBe("queued");
    expect(draft.resume).toBeNull();
    expect(draft.diff).toEqual([]);
    expect(typeof draft.model).toBe("string");

    await waitForTerminal(draft.id);

    const row = await tailoredResumesRepo.getById(draft.id, BOOTSTRAP_ADMIN_ID);
    expect(row?.status).toBe("completed");
    expect(row?.structured).toEqual(TAILORED_STORE);
    expect(row?.diff).toEqual(TAILOR_DIFF);
    expect(row?.model).toBe("mock");
    expect(row?.completedAt).not.toBeNull();
  });

  it("emits SSE progress stages in order analyze -> rewrite -> render -> done", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    await insertResume(state.testDb, { isActive: true });

    const llm = makeMockLlm({ tailor: { resume: TAILORED_STORE, diff: TAILOR_DIFF } });

    const events: { event: string; stage?: string }[] = [];
    const draft = await startTailor(BOOTSTRAP_ADMIN_ID, { jobId: job.id }, { llm });
    const handle = getRunHandle(draft.id);
    expect(handle).toBeDefined();

    await new Promise<void>((resolve) => {
      handle!.subscribe((event) => {
        events.push({ event: event.event, stage: (event.data as { stage?: string })?.stage });
        if (event.event === "done" || event.event === "error") resolve();
      });
    });

    const progressStages = events.filter((e) => e.event === "progress").map((e) => e.stage);
    expect(progressStages).toEqual(["analyze", "rewrite", "render"]);
    expect(events[events.length - 1].event).toBe("done");
  });

  // task-B8 review pass, Finding 1: two diff entries naming the same section
  // must be rejected (fail loud) — otherwise finalizeTailor's
  // `merged[section] = tailored[section]` would leak whichever entry was
  // REJECTED into the merge, since it can't tell which entry's content is
  // "the" tailored section.
  it("fails the run loudly (not a silent merge) when the model emits two diff entries for the same section", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    await insertResume(state.testDb, { isActive: true });

    const duplicateSectionDiff = [
      { section: "experience", op: "modify" as const, before: "old bullet A", after: "new bullet A", reason: "surface relevant work" },
      { section: "experience", op: "modify" as const, before: "old bullet B", after: "new bullet B", reason: "surface more relevant work" },
    ];
    const llm = makeMockLlm({ tailor: { resume: TAILORED_STORE, diff: duplicateSectionDiff } });

    const draft = await startTailor(BOOTSTRAP_ADMIN_ID, { jobId: job.id }, { llm });
    await waitForTerminal(draft.id);

    const row = await tailoredResumesRepo.getById(draft.id, BOOTSTRAP_ADMIN_ID);
    expect(row?.status).toBe("failed");
  });
});
