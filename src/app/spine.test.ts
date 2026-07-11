// Route-level F1–F6 spine integration test (task-B10-brief.md "Testing —
// HONEST about the environment"). No real Chromium/DATABASE_URL/
// OPENROUTER_API_KEY this session, so this drives the REAL route handlers
// through the REAL `features/*/client.ts` wrappers — global `fetch` is
// stubbed to dispatch straight into the imported Next route handlers (no
// HTTP server), so every step below both exercises the actual persistence/
// scoring/tailoring pipeline (PGlite + makeMockLlm + mocked connectors) AND
// proves the typed clients `.parse` real route responses without drift.
//
// Asserts every spine transition: upload résumé -> dual-persona search ->
// scored feed -> job detail -> extract questions (paste) -> draft answers ->
// edit answers -> mark applied -> update tracker -> tailor -> finalize ->
// pdf.
import { NextRequest } from "next/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { waitFor } from "@/app/api/__test-utils__/poll";
import { makeMockLlm } from "@/lib/llm/mock";
import { JD_FACTS, MATCH_SCORE, QUESTION_ANSWER, QUESTION_EXTRACT, RESUME_STORE, TAILOR_RESULT } from "@/lib/llm/scripted-fixtures";
import { insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import {
  applicationAnswers,
  applications,
  jobs,
  jobScores,
  resumes,
  searchRuns,
  sources,
  tailoredResumes,
} from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import type { RawPosting, SourceConnector } from "@/server/search/connector";
import type { SourceRow } from "@/server/persistence/repos/sources";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const llm = vi.hoisted(() => ({ scripted: {} as Record<string, unknown> }));
vi.mock("@/lib/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/client")>();
  return { ...actual, getLlm: () => makeMockLlm(llm.scripted) };
});

const pdf = vi.hoisted(() => ({ htmlToPdf: vi.fn(async (_html: string) => Buffer.from("sentinel-pdf-bytes")) }));
vi.mock("@/lib/pdf", () => ({ htmlToPdf: pdf.htmlToPdf }));

// One posting per persona so the dual-persona upload-triggered search
// (features/resume + features/search wiring, src/app/resume/page.tsx) is
// exercised for both — same title so roleFuzzyMatch's ≥2-shared/Jaccard≥0.6
// rule passes against the résumé's "Senior Backend Engineer" + "Payments"
// skill for both listings.
const POSTINGS: Record<string, RawPosting> = {
  greenhouse: {
    sourceId: "greenhouse",
    url: "https://boards.greenhouse.io/grab/jobs/6041234",
    title: "Senior Backend Engineer, Payments",
    company: "Grab",
    location: "Remote",
    description: "Own the payments ledger service. Stack: Node.js, Kafka, Postgres. Payments domain experience valued.",
  },
  jobstreet: {
    sourceId: "jobstreet",
    url: "https://www.jobstreet.com.my/job/senior-backend-engineer-payments-991234",
    title: "Senior Backend Engineer, Payments",
    company: "Local Fintech Sdn Bhd",
    location: "Kuala Lumpur, Malaysia",
    description: "Build the merchant payments platform. Stack: Node.js, Postgres. Payments domain experience valued.",
  },
};

function stubConnector(source: SourceRow): SourceConnector {
  return {
    id: source.id,
    kind: source.kind,
    persona: source.persona,
    async *discover() {
      const posting = POSTINGS[source.id];
      if (posting) yield posting;
    },
  };
}
vi.mock("@/server/search/connectors", () => ({ connectorForSource: (source: SourceRow) => stubConnector(source) }));

// --- fakeFetch: dispatches straight into the imported route handlers, so
// features/*/client.ts's real `fetch(...)` calls exercise the real routes
// with no HTTP server in between.
const { POST: postResume, GET: getResumeRoute } = await import("./api/resume/route");
const { POST: postSearch } = await import("./api/search/route");
const { GET: getSearchRunRoute } = await import("./api/search/[id]/route");
const { GET: getJobsRoute } = await import("./api/jobs/route");
const { GET: getJobRoute } = await import("./api/jobs/[id]/route");
const { POST: postQuestions } = await import("./api/apply/questions/route");
const { POST: postAnswers } = await import("./api/apply/answers/route");
const { PATCH: patchAnswersRoute } = await import("./api/apply/answers/[id]/route");
const { POST: postApplications, GET: getApplicationsRoute } = await import("./api/applications/route");
const { PATCH: patchApplicationRoute } = await import("./api/applications/[id]/route");
const { POST: postTailor } = await import("./api/tailor/route");
const { GET: getTailorRoute } = await import("./api/tailor/[id]/route");
const { POST: postFinalize } = await import("./api/tailor/[id]/finalize/route");
const { GET: getPdfRoute } = await import("./api/tailor/[id]/pdf/route");

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function fakeFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input), "http://localhost");
  const method = (init.method ?? "GET").toUpperCase();
  const req = new NextRequest(url.toString(), init as ConstructorParameters<typeof NextRequest>[1]);
  const path = url.pathname;
  let m: RegExpMatchArray | null;

  if (path === "/api/resume") return method === "GET" ? getResumeRoute() : postResume(req);
  if (path === "/api/search") return postSearch(req);
  if ((m = path.match(/^\/api\/search\/([^/]+)$/))) return getSearchRunRoute(req, params(m[1]));
  if (path === "/api/jobs") return getJobsRoute(req);
  if ((m = path.match(/^\/api\/jobs\/([^/]+)$/))) return getJobRoute(req, params(m[1]));
  if (path === "/api/apply/questions") return postQuestions(req);
  if (path === "/api/apply/answers") return postAnswers(req);
  if ((m = path.match(/^\/api\/apply\/answers\/([^/]+)$/))) return patchAnswersRoute(req, params(m[1]));
  if (path === "/api/applications") return method === "GET" ? getApplicationsRoute(req) : postApplications(req);
  if ((m = path.match(/^\/api\/applications\/([^/]+)$/))) return patchApplicationRoute(req, params(m[1]));
  if (path === "/api/tailor") return postTailor(req);
  if ((m = path.match(/^\/api\/tailor\/([^/]+)\/finalize$/))) return postFinalize(req, params(m[1]));
  if ((m = path.match(/^\/api\/tailor\/([^/]+)\/pdf$/))) return getPdfRoute(req, params(m[1]));
  if ((m = path.match(/^\/api\/tailor\/([^/]+)$/))) return getTailorRoute(req, params(m[1]));
  throw new Error(`fakeFetch: no route wired for ${method} ${path}`);
}
vi.stubGlobal("fetch", fakeFetch);

const { uploadResume, getResume } = await import("@/features/resume/client");
const { startSearch, getSearchRun } = await import("@/features/search/client");
const { getJobs, getJob } = await import("@/features/feed/client");
const { extractQuestions, draftAnswers, patchAnswers } = await import("@/features/apply/client");
const { markApplied, listApplications, patchApplication } = await import("@/features/applied/client");
const { startTailor, getTailor, finalizeTailor, tailorPdfUrl } = await import("@/features/tailor/client");

describe("F1–F6 spine (route-level, mocked externals)", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  afterEach(async () => {
    llm.scripted = {};
    pdf.htmlToPdf.mockClear();
    const { __resetForTests } = await import("@/server/runs/registry");
    __resetForTests();
    await state.testDb.delete(applications);
    await state.testDb.delete(applicationAnswers);
    await state.testDb.delete(tailoredResumes);
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(searchRuns);
    await state.testDb.delete(resumes);
    await state.testDb.delete(sources);
  });

  it("drives upload -> dual-persona search -> feed -> detail -> questions -> answers -> mark-applied -> tailor -> finalize -> pdf", async () => {
    await insertSource(state.testDb, { id: "greenhouse", kind: "ats", persona: "remote", enabled: true });
    await insertSource(state.testDb, { id: "jobstreet", kind: "board", persona: "local", enabled: true });
    llm.scripted = { "resume-extract": RESUME_STORE, "jd-extract": JD_FACTS, "match-score": MATCH_SCORE };

    // --- F1: upload (features/resume/client -> POST/GET /api/resume) ---
    expect(await getResume()).toBeNull();
    const resume = await uploadResume({ text: "a".repeat(120) });
    expect(resume.headline).toBe("Senior Backend Engineer");
    expect((await getResume())?.id).toBe(resume.id);

    // --- F2: dual-persona search (features/search/client -> POST /api/search x2) ---
    const [remoteRun, localRun] = await Promise.all([
      startSearch({ persona: "remote" }),
      startSearch({ persona: "local" }),
    ]);
    expect(remoteRun.status).toBe("queued");
    expect(localRun.status).toBe("queued");
    expect(remoteRun.persona).toBe("remote");
    expect(localRun.persona).toBe("local");
    expect(remoteRun.id).not.toBe(localRun.id);

    const remoteDone = await waitFor(() => getSearchRun(remoteRun.id), (r) => r.status === "completed" || r.status === "failed");
    const localDone = await waitFor(() => getSearchRun(localRun.id), (r) => r.status === "completed" || r.status === "failed");
    expect(remoteDone.status).toBe("completed");
    expect(localDone.status).toBe("completed");
    expect(remoteDone.stats.worth).toBeGreaterThanOrEqual(1);
    expect(localDone.stats.worth).toBeGreaterThanOrEqual(1);

    // --- F2: scored feed (features/feed/client -> GET /api/jobs) ---
    const remoteFeed = await getJobs({ persona: "remote" });
    const localFeed = await getJobs({ persona: "local" });
    expect(remoteFeed.items).toHaveLength(1);
    expect(localFeed.items).toHaveLength(1);
    expect(remoteFeed.stats.worth).toBeGreaterThanOrEqual(1);
    const job = remoteFeed.items[0];
    expect(job.company).toBe("Grab");
    expect(job.legitimacy.tier).toBe("clear");
    expect(job.applyUrl).toBe(POSTINGS.greenhouse.url);

    // --- F3: job detail (features/feed/client -> GET /api/jobs/:id) ---
    const detail = await getJob(job.id);
    expect(detail.id).toBe(job.id);
    expect(detail.applyUrl).toMatch(/^https:\/\//);

    // --- F4: extract questions, tier 3 paste (features/apply/client) ---
    llm.scripted.tailor = TAILOR_RESULT;
    llm.scripted["question-extract"] = QUESTION_EXTRACT;
    const extracted = await extractQuestions({ pastedForm: "Why do you want to work here? ____" });
    expect(extracted.sourceUrl).toBeNull();
    expect(extracted.questions).toHaveLength(1);

    // --- F4: draft answers ---
    llm.scripted["question-answer"] = QUESTION_ANSWER;
    const drafted = await draftAnswers({ jobId: job.id, questions: extracted.questions });
    expect(drafted.answers[0].grounding).toHaveLength(1);

    // --- F4: edit/persist answers (PATCH) ---
    const editedAnswer = { ...drafted.answers[0], answer: "Edited: because of the payments-scale challenge." };
    const patched = await patchAnswers(drafted.id, [editedAnswer]);
    expect(patched.answers[0].answer).toBe(editedAnswer.answer);

    // --- F5: mark applied + tracker update ---
    const application = await markApplied({ jobId: job.id, answersId: drafted.id });
    expect(application.stage).toBe(0);
    expect(application.statusTone).toBe("good");
    const tracked = await listApplications({ limit: 10 });
    expect(tracked.items.some((a) => a.id === application.id)).toBe(true);
    const updated = await patchApplication(application.id, { note: "Recruiter screen booked." });
    expect(updated.note).toBe("Recruiter screen booked.");

    // --- F6: tailor -> finalize -> pdf ---
    const tailorDraft = await startTailor({ jobId: job.id });
    expect(tailorDraft.status).toBe("queued");
    const tailorDone = await waitFor(() => getTailor(tailorDraft.id), (r) => r.status === "completed" || r.status === "failed");
    expect(tailorDone.status).toBe("completed");
    expect(tailorDone.diff).toHaveLength(1);

    const finalized = await finalizeTailor(tailorDone.id, [0]);
    expect(finalized.resume?.summary).toBe(TAILOR_RESULT.resume.summary);

    const pdfRes = await fetch(tailorPdfUrl(finalized.id));
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers.get("content-type")).toMatch(/application\/pdf/);
    expect(pdf.htmlToPdf).toHaveBeenCalledTimes(1);
  });
});
