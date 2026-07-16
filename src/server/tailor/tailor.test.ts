import { eq } from "drizzle-orm";
import { z } from "zod";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeMockLlm } from "@/lib/llm/mock";
import { insertJob, insertJobScore, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { correlationReports, jobs, jobScores, resumes, sources, tailoredResumes, users } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { startTailor, UnknownJobError, NoActiveResumeError, UnknownReportError, TailorEmitSchema } = await import("./index");
const { tailoredResumesRepo } = await import("@/server/persistence/repos/tailoredResumes");
const { applyEdits } = await import("./merge");
const { get: getRunHandle, __resetForTests } = await import("@/server/runs/registry");

// Résumé fixture with two bullets on one role: one bullet ("Led distributed
// payments platform") is real evidence a correlation report can cite as
// `buried`; the second bullet lets "two edits in the same section" tests
// target a distinct bulletIndex without inventing content.
const BASE_STRUCTURED = {
  storeVersion: 2 as const,
  extractionPath: "text" as const,
  name: "Jane Doe",
  contact: [
    { label: "email", value: "jane@example.com" },
    { label: "location", value: "Kuala Lumpur, Malaysia" },
  ],
  summary: "Backend engineer.",
  experience: [
    {
      company: "Acme Corp",
      title: "Senior Backend Engineer",
      dates: "2020–Present",
      isCurrent: true,
      bullets: ["Led distributed payments platform", "Mentored junior engineers"],
    },
  ],
  education: [],
  skills: [],
  projects: [],
  certifications: [],
  languages: [],
  sections: [],
};

type ReportRow = {
  requirement: string;
  term: string;
  kind: "must" | "nice" | "responsibility";
  status: "met" | "buried" | "gap";
  evidence: string | null;
  atsPresent: boolean;
  reason: string;
  note: string | null;
};

const REPORT_ROWS: ReportRow[] = [
  {
    requirement: "distributed systems experience",
    term: "distributed",
    kind: "must",
    status: "buried",
    evidence: "Led distributed payments platform",
    atsPresent: true,
    reason: "mentioned once, not emphasized",
    note: null,
  },
  {
    requirement: "Kubernetes",
    term: "kubernetes",
    kind: "nice",
    status: "gap",
    evidence: null,
    atsPresent: false,
    reason: "no evidence in résumé",
    note: null,
  },
];

const TAILOR_DIFF = [
  {
    section: "experience",
    op: "modify" as const,
    before: "Led distributed payments platform",
    after: "Led distributed payments platform spanning a distributed systems architecture",
    reason: "surface distributed systems experience",
    requirement: "distributed systems experience",
    target: { index: 0, bulletIndex: 0 },
  },
];

const FABRICATED_DIFF = [
  {
    section: "experience",
    op: "modify" as const,
    before: "Led distributed payments platform",
    after: "Led distributed payments platform, reducing latency by 40%",
    reason: "quantify impact",
    requirement: "distributed systems experience",
    target: { index: 0, bulletIndex: 0 },
  },
];

const GAP_DIFF = [
  {
    section: "experience",
    op: "modify" as const,
    before: "Led distributed payments platform",
    after: "Led distributed payments platform using Kubernetes for orchestration",
    reason: "claim Kubernetes",
    requirement: "Kubernetes",
    target: { index: 0, bulletIndex: 0 },
  },
];

const INVENTED_REQUIREMENT_DIFF = [
  {
    section: "experience",
    op: "modify" as const,
    before: "Led distributed payments platform",
    after: "Led distributed payments platform with advanced observability tooling",
    reason: "invented capability not present as a met/buried row in the report",
    requirement: "advanced observability tooling",
    target: { index: 0, bulletIndex: 0 },
  },
];

// `before` omitted on a `modify` — the model-output schema (TailorResultSchema's
// superRefine) must reject this outright; gpt-oss-120b is known to omit
// optional json_schema fields, and a missing anchor risks silently rewriting
// the wrong bullet.
const MISSING_BEFORE_DIFF = [
  {
    section: "experience",
    op: "modify" as const,
    after: "Led distributed payments platform spanning a distributed systems architecture",
    reason: "surface distributed systems experience",
    requirement: "distributed systems experience",
    target: { index: 0, bulletIndex: 0 },
  },
];

// Emit-shape `add` with an explicit `before: null` (the anchor doesn't apply
// to `add`) — TailorEmitSchema requires the key, and normalisation must
// strip it back to absent on the wire shape.
const ADD_NULL_BEFORE_DIFF = [
  {
    section: "experience",
    op: "add" as const,
    before: null,
    after: "Scaled a distributed systems platform to new regions",
    reason: "surface distributed systems experience",
    requirement: "distributed systems experience",
    target: { index: 0, bulletIndex: null },
  },
];

// Emit-shape `modify` with an explicit `before: null` — normalisation turns
// this into an absent `before` on the wire shape, which TailorResultSchema's
// superRefine must still reject.
const MODIFY_NULL_BEFORE_DIFF = [
  {
    section: "experience",
    op: "modify" as const,
    before: null,
    after: "Led distributed payments platform spanning a distributed systems architecture",
    reason: "surface distributed systems experience",
    requirement: "distributed systems experience",
    target: { index: 0, bulletIndex: 0 },
  },
];

const TWO_EDIT_DIFF = [
  {
    section: "experience",
    op: "modify" as const,
    before: "Led distributed payments platform",
    after: "Led distributed payments platform spanning a distributed systems architecture",
    reason: "surface distributed systems experience",
    requirement: "distributed systems experience",
    target: { index: 0, bulletIndex: 0 },
  },
  {
    section: "experience",
    op: "modify" as const,
    before: "Mentored junior engineers",
    after: "Mentored junior engineers on distributed systems best practices",
    reason: "surface distributed systems experience elsewhere too",
    requirement: "distributed systems experience",
    target: { index: 0, bulletIndex: 1 },
  },
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

async function insertCompletedReport(
  jobId: string,
  resumeId: string,
  rows: ReportRow[] = REPORT_ROWS,
) {
  const [row] = await state.testDb
    .insert(correlationReports)
    .values({
      userId: BOOTSTRAP_ADMIN_ID,
      jobId,
      resumeId,
      rows,
      semantic: {
        met: rows.filter((r) => r.status === "met").length,
        buried: rows.filter((r) => r.status === "buried").length,
        gap: rows.filter((r) => r.status === "gap").length,
        total: rows.length,
      },
      ats: {
        present: rows.filter((r) => r.atsPresent).length,
        total: rows.length,
        missing: rows.filter((r) => !r.atsPresent).map((r) => r.term),
      },
      status: "completed",
      model: "test-model",
      costUsd: 0.01,
      completedAt: new Date(),
    })
    .returning();
  return row;
}

describe("startTailor", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  afterEach(async () => {
    __resetForTests();
    await state.testDb.delete(tailoredResumes);
    await state.testDb.delete(correlationReports);
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

  it("returns a queued draft immediately, then completes async with a report-driven diff[] carrying requirement+target, structured derived via applyEdits", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true, structured: BASE_STRUCTURED });
    const report = await insertCompletedReport(job.id, resume.id);

    const llm = makeMockLlm({ tailor: { diff: TAILOR_DIFF } });

    const draft = await startTailor(BOOTSTRAP_ADMIN_ID, { jobId: job.id, reportId: report.id }, { llm });
    expect(draft.status).toBe("queued");
    expect(draft.resume).toBeNull();
    expect(draft.diff).toEqual([]);
    expect(typeof draft.model).toBe("string");

    await waitForTerminal(draft.id);

    const row = await tailoredResumesRepo.getById(draft.id, BOOTSTRAP_ADMIN_ID);
    expect(row?.status).toBe("completed");
    expect(row?.reportId).toBe(report.id);
    expect(row?.diff).toEqual(TAILOR_DIFF);
    expect(row?.diff[0].requirement).toBe("distributed systems experience");
    expect(row?.diff[0].target).toEqual({ index: 0, bulletIndex: 0 });
    expect(row?.structured).toEqual(applyEdits(BASE_STRUCTURED, TAILOR_DIFF));
    expect(row?.model).toBe("mock");
    expect(row?.completedAt).not.toBeNull();
    // release() evicts the handle from the registry on terminal completion
    // (perf/scan-overhead: long-lived processes must not accumulate handles).
    expect(getRunHandle(draft.id)).toBeUndefined();
  });

  it("carries forward the base résumé's extractionPath (vision) into the derived structured store", async () => {
    const visionResumeStructured = { ...BASE_STRUCTURED, extractionPath: "vision" as const };
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true, structured: visionResumeStructured });
    const report = await insertCompletedReport(job.id, resume.id);

    const llm = makeMockLlm({ tailor: { diff: TAILOR_DIFF } });

    const draft = await startTailor(BOOTSTRAP_ADMIN_ID, { jobId: job.id, reportId: report.id }, { llm });
    await waitForTerminal(draft.id);

    const row = await tailoredResumesRepo.getById(draft.id, BOOTSTRAP_ADMIN_ID);
    expect(row?.status).toBe("completed");
    expect(row?.structured?.extractionPath).toBe("vision");
    expect(row?.structured).toEqual(applyEdits(visionResumeStructured, TAILOR_DIFF));
  });

  it("computes its own correlation when no reportId is given (kills the staleness bug) and persists the resolved reportId", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true, structured: BASE_STRUCTURED });
    await insertJobScore(state.testDb, job.id, resume.id, {
      jdFacts: { title: "Backend Engineer", mustHaves: ["distributed systems experience"], niceToHaves: [], responsibilities: [], redFlags: [] },
    });

    const llm = makeMockLlm({
      correlate: {
        rows: [{ id: 0, term: "distributed", status: "buried", evidence: "Led distributed payments platform", reason: "r", note: null }],
      },
      tailor: { diff: TAILOR_DIFF },
    });

    const draft = await startTailor(BOOTSTRAP_ADMIN_ID, { jobId: job.id }, { llm });
    await waitForTerminal(draft.id);

    const row = await tailoredResumesRepo.getById(draft.id, BOOTSTRAP_ADMIN_ID);
    expect(row?.status).toBe("completed");
    expect(row?.reportId).not.toBeNull();
    expect(row?.diff).toEqual(TAILOR_DIFF);
    expect(row?.structured).toEqual(applyEdits(BASE_STRUCTURED, TAILOR_DIFF));
  });

  it("fails the run loudly (fabrication guard) when an edit's `after` introduces a metric absent from the base résumé", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true, structured: BASE_STRUCTURED });
    const report = await insertCompletedReport(job.id, resume.id);

    const llm = makeMockLlm({ tailor: { diff: FABRICATED_DIFF } });

    const draft = await startTailor(BOOTSTRAP_ADMIN_ID, { jobId: job.id, reportId: report.id }, { llm });
    await waitForTerminal(draft.id);

    const row = await tailoredResumesRepo.getById(draft.id, BOOTSTRAP_ADMIN_ID);
    expect(row?.status).toBe("failed");
  });

  it("fails the run loudly (gap guard) when an edit's requirement is a `gap` row from the report", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true, structured: BASE_STRUCTURED });
    const report = await insertCompletedReport(job.id, resume.id);

    const llm = makeMockLlm({ tailor: { diff: GAP_DIFF } });

    const draft = await startTailor(BOOTSTRAP_ADMIN_ID, { jobId: job.id, reportId: report.id }, { llm });
    await waitForTerminal(draft.id);

    const row = await tailoredResumesRepo.getById(draft.id, BOOTSTRAP_ADMIN_ID);
    expect(row?.status).toBe("failed");
  });

  it("fails the run loudly (requirement allowlist) when an edit's requirement matches no met/buried row in the report (invented, not just an exact gap-string match)", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true, structured: BASE_STRUCTURED });
    const report = await insertCompletedReport(job.id, resume.id);

    const llm = makeMockLlm({ tailor: { diff: INVENTED_REQUIREMENT_DIFF } });

    const draft = await startTailor(BOOTSTRAP_ADMIN_ID, { jobId: job.id, reportId: report.id }, { llm });
    await waitForTerminal(draft.id);

    const row = await tailoredResumesRepo.getById(draft.id, BOOTSTRAP_ADMIN_ID);
    expect(row?.status).toBe("failed");
  });

  it("fails the run loudly (schema) when a modify edit omits `before` — the mandatory WYSIWYG anchor", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true, structured: BASE_STRUCTURED });
    const report = await insertCompletedReport(job.id, resume.id);

    const llm = makeMockLlm({ tailor: { diff: MISSING_BEFORE_DIFF } });

    const draft = await startTailor(BOOTSTRAP_ADMIN_ID, { jobId: job.id, reportId: report.id }, { llm });
    await waitForTerminal(draft.id);

    const row = await tailoredResumesRepo.getById(draft.id, BOOTSTRAP_ADMIN_ID);
    expect(row?.status).toBe("failed");
  });

  it("throws synchronously (no tailored_resumes row inserted) when a supplied reportId was computed for a different job than this run's", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const otherJob = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true, structured: BASE_STRUCTURED });
    const report = await insertCompletedReport(otherJob.id, resume.id);

    const llm = makeMockLlm({ tailor: { diff: TAILOR_DIFF } });

    // startTailor's synchronous identity check (index.ts) now catches a
    // wrong-job reportId BEFORE any tailored_resumes row is inserted — a
    // row referencing another job's report would otherwise FK-block
    // deleting that other job even after Fix 1's cascade.
    await expect(
      startTailor(BOOTSTRAP_ADMIN_ID, { jobId: job.id, reportId: report.id }, { llm }),
    ).rejects.toThrow(/not this tailor run's job/);

    const rows = await state.testDb.select().from(tailoredResumes).where(eq(tailoredResumes.jobId, job.id));
    expect(rows).toHaveLength(0);
  });

  it("throws synchronously (no tailored_resumes row inserted) when a supplied reportId was computed against a different résumé than this run's base résumé (staleness guard)", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true, structured: BASE_STRUCTURED });
    const staleResume = await insertResume(state.testDb, { isActive: false, structured: BASE_STRUCTURED });
    const report = await insertCompletedReport(job.id, staleResume.id);

    const llm = makeMockLlm({ tailor: { diff: TAILOR_DIFF } });

    await expect(
      startTailor(BOOTSTRAP_ADMIN_ID, { jobId: job.id, reportId: report.id }, { llm }),
    ).rejects.toThrow(/refusing to rewrite from a stale report/);

    const rows = await state.testDb.select().from(tailoredResumes).where(eq(tailoredResumes.jobId, job.id));
    expect(rows).toHaveLength(0);
  });

  it("404s (UnknownReportError) synchronously when reportId belongs to a different user (no existence leak, no tailored_resumes row inserted)", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true, structured: BASE_STRUCTURED });
    const [userB] = await state.testDb
      .insert(users)
      .values({ email: "user-b-unknownreport@example.com", passwordHash: "h", role: "user" })
      .returning();
    const [foreignReport] = await state.testDb
      .insert(correlationReports)
      .values({
        userId: userB.id,
        jobId: job.id,
        resumeId: resume.id,
        rows: [],
        status: "completed",
        model: "test-model",
        completedAt: new Date(),
      })
      .returning();

    const llm = makeMockLlm({ tailor: { diff: TAILOR_DIFF } });

    // Existence/ownership of a caller-supplied reportId is now checked
    // SYNCHRONOUSLY in startTailor (index.ts), before the tailored_resumes
    // row is even inserted — a foreign-owned reportId rejects the request
    // outright rather than inserting a doomed row that fails async.
    await expect(
      startTailor(BOOTSTRAP_ADMIN_ID, { jobId: job.id, reportId: foreignReport.id }, { llm }),
    ).rejects.toBeInstanceOf(UnknownReportError);
  });

  it("fails the run loudly when reportId points to a report that has not completed yet", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true, structured: BASE_STRUCTURED });
    const [queuedReport] = await state.testDb
      .insert(correlationReports)
      .values({
        userId: BOOTSTRAP_ADMIN_ID,
        jobId: job.id,
        resumeId: resume.id,
        rows: [],
        status: "queued",
        model: "test-model",
      })
      .returning();

    const llm = makeMockLlm({ tailor: { diff: TAILOR_DIFF } });

    const draft = await startTailor(BOOTSTRAP_ADMIN_ID, { jobId: job.id, reportId: queuedReport.id }, { llm });
    await waitForTerminal(draft.id);

    const row = await tailoredResumesRepo.getById(draft.id, BOOTSTRAP_ADMIN_ID);
    expect(row?.status).toBe("failed");
  });

  it("emits SSE progress stages in order correlate -> rewrite -> render -> done", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true, structured: BASE_STRUCTURED });
    const report = await insertCompletedReport(job.id, resume.id);

    const llm = makeMockLlm({ tailor: { diff: TAILOR_DIFF } });

    const events: { event: string; stage?: string }[] = [];
    const draft = await startTailor(BOOTSTRAP_ADMIN_ID, { jobId: job.id, reportId: report.id }, { llm });
    const handle = getRunHandle(draft.id);
    expect(handle).toBeDefined();

    await new Promise<void>((resolve) => {
      handle!.subscribe((event) => {
        events.push({ event: event.event, stage: (event.data as { stage?: string })?.stage });
        if (event.event === "done" || event.event === "error") resolve();
      });
    });

    const progressStages = events.filter((e) => e.event === "progress").map((e) => e.stage);
    expect(progressStages).toEqual(["correlate", "rewrite", "render"]);
    expect(events[events.length - 1].event).toBe("done");
  });

  // Task 1/9 retired the one-entry-per-section constraint: each diff entry
  // now addresses a distinct target.index/bulletIndex, so two edits naming
  // the same section are valid as long as they target distinct bullets.
  it("allows two edits in the same section when they target distinct bullets", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true, structured: BASE_STRUCTURED });
    const report = await insertCompletedReport(job.id, resume.id);

    const llm = makeMockLlm({ tailor: { diff: TWO_EDIT_DIFF } });

    const draft = await startTailor(BOOTSTRAP_ADMIN_ID, { jobId: job.id, reportId: report.id }, { llm });
    await waitForTerminal(draft.id);

    const row = await tailoredResumesRepo.getById(draft.id, BOOTSTRAP_ADMIN_ID);
    expect(row?.status).toBe("completed");
    expect(row?.diff).toEqual(TWO_EDIT_DIFF);
    expect(row?.structured).toEqual(applyEdits(BASE_STRUCTURED, TWO_EDIT_DIFF));
  });

  it("tailor emit schema requires before/after (gpt-oss-120b drops non-required fields)", () => {
    const js = z.toJSONSchema(TailorEmitSchema) as any;
    const entry = js.properties.diff.items;
    for (const k of ["section", "op", "before", "after", "reason", "requirement", "target"]) {
      expect(entry.required).toContain(k);
    }
  });

  it("normalises an emit-shape `add` with before:null to an absent `before` on the wire shape", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true, structured: BASE_STRUCTURED });
    const report = await insertCompletedReport(job.id, resume.id);

    const llm = makeMockLlm({ tailor: { diff: ADD_NULL_BEFORE_DIFF } });

    const draft = await startTailor(BOOTSTRAP_ADMIN_ID, { jobId: job.id, reportId: report.id }, { llm });
    await waitForTerminal(draft.id);

    const row = await tailoredResumesRepo.getById(draft.id, BOOTSTRAP_ADMIN_ID);
    expect(row?.status).toBe("completed");
    expect(row?.diff[0]).not.toHaveProperty("before");
    expect(row?.diff[0].after).toBe(ADD_NULL_BEFORE_DIFF[0].after);
  });

  it("fails the run loudly (schema) when a modify edit emits before:null (normalises to absent, still rejected)", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true, structured: BASE_STRUCTURED });
    const report = await insertCompletedReport(job.id, resume.id);

    const llm = makeMockLlm({ tailor: { diff: MODIFY_NULL_BEFORE_DIFF } });

    const draft = await startTailor(BOOTSTRAP_ADMIN_ID, { jobId: job.id, reportId: report.id }, { llm });
    await waitForTerminal(draft.id);

    const row = await tailoredResumesRepo.getById(draft.id, BOOTSTRAP_ADMIN_ID);
    expect(row?.status).toBe("failed");
  });

  // Corrective retry (emitTailorRewrite, index.ts): a structurally invalid
  // diff — a list-section `modify` with `target.bulletIndex: null` — passes
  // TailorEmitSchema/TailorResultSchema (bulletIndex is nullable at the wire
  // level too) but fails applyEdits's own dry-run (InvalidDiffIndexError,
  // merge.ts), which is exactly the intermittent bug this retry exists for.
  const BULLETINDEX_NULL_DIFF = [{ ...TAILOR_DIFF[0], target: { index: 0, bulletIndex: null } }];

  it("retries once on a structurally invalid first attempt (list-section modify with null bulletIndex) and persists the corrected second attempt", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true, structured: BASE_STRUCTURED });
    const report = await insertCompletedReport(job.id, resume.id);

    let tailorCalls = 0;
    const llm = makeMockLlm(({ task }) => {
      if (task !== "tailor") throw new Error(`unexpected task "${task}"`);
      tailorCalls++;
      return tailorCalls === 1 ? { diff: BULLETINDEX_NULL_DIFF } : { diff: TAILOR_DIFF };
    });

    const draft = await startTailor(BOOTSTRAP_ADMIN_ID, { jobId: job.id, reportId: report.id }, { llm });
    await waitForTerminal(draft.id);

    const row = await tailoredResumesRepo.getById(draft.id, BOOTSTRAP_ADMIN_ID);
    expect(row?.status).toBe("completed");
    expect(row?.diff).toEqual(TAILOR_DIFF);
    expect(tailorCalls).toBe(2);
  });

  it("fails the run loudly when the corrective retry's second attempt is also structurally invalid (bounded to one retry)", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true, structured: BASE_STRUCTURED });
    const report = await insertCompletedReport(job.id, resume.id);

    let tailorCalls = 0;
    const llm = makeMockLlm(({ task }) => {
      if (task !== "tailor") throw new Error(`unexpected task "${task}"`);
      tailorCalls++;
      return { diff: BULLETINDEX_NULL_DIFF };
    });

    const draft = await startTailor(BOOTSTRAP_ADMIN_ID, { jobId: job.id, reportId: report.id }, { llm });
    await waitForTerminal(draft.id);

    const row = await tailoredResumesRepo.getById(draft.id, BOOTSTRAP_ADMIN_ID);
    expect(row?.status).toBe("failed");
    expect(tailorCalls).toBe(2);
  });

  // Widened retry (CHANGE 2): llm.complete's own responseSchema.parse
  // (client.ts:127, or here the mock's equivalent in mock.ts) used to throw
  // OUTSIDE this function's old try-block — a raw emission that violates
  // even the all-required TailorEmitSchema (e.g. `before` omitted entirely,
  // not just null) would kill the run with no retry at all. MISSING_BEFORE_DIFF
  // already fails TailorEmitSchema (a required key, not merely the
  // superRefine below it), so scripting it as attempt 1 exercises exactly
  // that client-side ZodError.
  it("retries once when the raw emission itself fails the client-side schema parse (not just the deterministic checks after it)", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true, structured: BASE_STRUCTURED });
    const report = await insertCompletedReport(job.id, resume.id);

    let tailorCalls = 0;
    const llm = makeMockLlm(({ task }) => {
      if (task !== "tailor") throw new Error(`unexpected task "${task}"`);
      tailorCalls++;
      return tailorCalls === 1 ? { diff: MISSING_BEFORE_DIFF } : { diff: TAILOR_DIFF };
    });

    const draft = await startTailor(BOOTSTRAP_ADMIN_ID, { jobId: job.id, reportId: report.id }, { llm });
    await waitForTerminal(draft.id);

    const row = await tailoredResumesRepo.getById(draft.id, BOOTSTRAP_ADMIN_ID);
    expect(row?.status).toBe("completed");
    expect(row?.diff).toEqual(TAILOR_DIFF);
    expect(tailorCalls).toBe(2);
  });

  // Fabrication as a retryable pre-check (CHANGE 3): a structurally valid
  // diff whose `after` writes in a JD numeral is now retried once inside
  // emitTailorRewrite (TailorFabricationError, isRetryableEmitError) rather
  // than only failing the run outright — the corrective feedback message
  // even calls out the never-introduce-a-digit rule. runTailorJob's own
  // post-return fabrication check stays as defense in depth.
  it("retries once when a structurally valid diff fails only the fabrication guard, and persists the corrected second attempt", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true, structured: BASE_STRUCTURED });
    const report = await insertCompletedReport(job.id, resume.id);

    let tailorCalls = 0;
    const llm = makeMockLlm(({ task }) => {
      if (task !== "tailor") throw new Error(`unexpected task "${task}"`);
      tailorCalls++;
      return tailorCalls === 1 ? { diff: FABRICATED_DIFF } : { diff: TAILOR_DIFF };
    });

    const draft = await startTailor(BOOTSTRAP_ADMIN_ID, { jobId: job.id, reportId: report.id }, { llm });
    await waitForTerminal(draft.id);

    const row = await tailoredResumesRepo.getById(draft.id, BOOTSTRAP_ADMIN_ID);
    expect(row?.status).toBe("completed");
    expect(row?.diff).toEqual(TAILOR_DIFF);
    expect(tailorCalls).toBe(2);
  });

  it("fails the run loudly when both attempts fail the fabrication guard (bounded to one retry)", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    const resume = await insertResume(state.testDb, { isActive: true, structured: BASE_STRUCTURED });
    const report = await insertCompletedReport(job.id, resume.id);

    let tailorCalls = 0;
    const llm = makeMockLlm(({ task }) => {
      if (task !== "tailor") throw new Error(`unexpected task "${task}"`);
      tailorCalls++;
      return { diff: FABRICATED_DIFF };
    });

    const draft = await startTailor(BOOTSTRAP_ADMIN_ID, { jobId: job.id, reportId: report.id }, { llm });
    await waitForTerminal(draft.id);

    const row = await tailoredResumesRepo.getById(draft.id, BOOTSTRAP_ADMIN_ID);
    expect(row?.status).toBe("failed");
    expect(tailorCalls).toBe(2);
  });
});
