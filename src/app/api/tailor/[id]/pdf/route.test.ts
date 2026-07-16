// GET /api/tailor/:id/pdf — 409 RUN_NOT_READY until finalized, then 200
// application/pdf via an INJECTED fake `htmlToPdf` (task-B8-brief.md
// "Playwright-browserless-in-tests rule"): no real Chromium is ever launched
// by this test — "@/lib/pdf" is mocked wholesale, same technique the rest of
// this codebase uses to keep "@/lib/llm/client" out of unit tests.
import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderCvHtml } from "@/lib/resume-render";
import { insertJob, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { jobs, resumes, sources, tailoredResumes, users } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";
import { UnauthorizedError } from "@/server/auth/errors";
import type { TailorDiffEntry } from "@/types";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { requireUser } = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/server/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/server/auth/session")>()),
  requireUser: () => requireUser(),
}));

const pdf = vi.hoisted(() => ({ htmlToPdf: vi.fn(async (_html: string) => Buffer.from("sentinel-pdf-bytes")) }));
vi.mock("@/lib/pdf", () => ({ htmlToPdf: pdf.htmlToPdf }));

const { POST: postFinalize } = await import("../finalize/route");
const { GET } = await import("./route");

const BASE_STORE = {
  storeVersion: 2 as const,
  extractionPath: "text" as const,
  name: "Jane Doe",
  contact: [
    { label: "email", value: "jane@example.com" },
    { label: "location", value: "Kuala Lumpur, Malaysia" },
    { label: "headline", value: "Backend Engineer" },
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
  summary: "Backend engineer specializing in payments.",
  experience: [{ ...BASE_STORE.experience[0], bullets: [...BASE_STORE.experience[0].bullets, "Speaks English and Malay"] }],
};

const DIFF: TailorDiffEntry[] = [
  {
    section: "summary", op: "modify", before: BASE_STORE.summary, after: TAILORED_STORE.summary,
    reason: "sharper framing", requirement: "payments framing",
    target: { index: null, bulletIndex: null },
  },
  {
    section: "experience", op: "add", after: "Speaks English and Malay",
    reason: "JD language requirement", requirement: "language requirement",
    target: { index: 0, bulletIndex: null },
  },
];

function getPdfRequest(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/tailor/${id}/pdf`);
}

describe("GET /api/tailor/:id/pdf", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  beforeEach(() => {
    requireUser.mockReset();
    requireUser.mockResolvedValue({ id: BOOTSTRAP_ADMIN_ID, email: "admin@example.com", role: "admin" });
  });

  afterEach(async () => {
    pdf.htmlToPdf.mockClear();
    await state.testDb.delete(tailoredResumes);
    await state.testDb.delete(jobs);
    await state.testDb.delete(resumes);
    await state.testDb.delete(sources);
  });

  it("401s with UNAUTHORIZED when there is no session", async () => {
    requireUser.mockRejectedValue(new UnauthorizedError());
    const id = crypto.randomUUID();
    const res = await GET(getPdfRequest(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("unknown id -> 404 NOT_FOUND", async () => {
    const id = "00000000-0000-0000-0000-000000000000";
    const res = await GET(getPdfRequest(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("a malformed (non-uuid) id returns 404 NOT_FOUND, never a 500", async () => {
    const id = "not-a-uuid";
    const res = await GET(getPdfRequest(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("409 RUN_NOT_READY before finalize (even once the tailor run has completed)", async () => {
    const { tailoredResumesRepo } = await import("@/server/persistence/repos/tailoredResumes");
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
      costUsd: 0.01,
      completedAt: new Date(),
    });

    const res = await GET(getPdfRequest(draft.id), { params: Promise.resolve({ id: draft.id }) });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("RUN_NOT_READY");
    expect(pdf.htmlToPdf).not.toHaveBeenCalled();
  });

  it("200 application/pdf after finalize — renderer receives the accepted-only HTML", async () => {
    const { tailoredResumesRepo } = await import("@/server/persistence/repos/tailoredResumes");
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
      costUsd: 0.01,
      completedAt: new Date(),
    });

    // Accept only the summary rewrite (index 0), reject the extras addition
    // (index 1) — the finalized/rendered HTML must reflect that split.
    const finalizeRes = await postFinalize(
      new NextRequest(`http://localhost/api/tailor/${draft.id}/finalize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acceptedIndices: [0] }),
      }),
      { params: Promise.resolve({ id: draft.id }) },
    );
    expect(finalizeRes.status).toBe(200);

    const res = await GET(getPdfRequest(draft.id), { params: Promise.resolve({ id: draft.id }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/pdf/);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.toString()).toBe("sentinel-pdf-bytes");

    expect(pdf.htmlToPdf).toHaveBeenCalledTimes(1);
    const renderedHtml = pdf.htmlToPdf.mock.calls[0][0] as string;
    const expectedHtml = renderCvHtml({ ...BASE_STORE, summary: TAILORED_STORE.summary }); // accepted summary, rejected extras
    expect(renderedHtml).toBe(expectedHtml);
    expect(renderedHtml).not.toContain("Speaks English and Malay");
  });

  it("re-finalize with a different accepted set (Finding 2, non-destructive): the pdf renders whatever finalize LAST accepted", async () => {
    const { tailoredResumesRepo } = await import("@/server/persistence/repos/tailoredResumes");
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
      costUsd: 0.01,
      completedAt: new Date(),
    });

    // First finalize accepts the summary rewrite (index 0).
    await postFinalize(
      new NextRequest(`http://localhost/api/tailor/${draft.id}/finalize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acceptedIndices: [0] }),
      }),
      { params: Promise.resolve({ id: draft.id }) },
    );

    // Re-finalize: the user changes their mind — accept the extras addition
    // (index 1) instead, reject the summary rewrite this time.
    const refinalizeRes = await postFinalize(
      new NextRequest(`http://localhost/api/tailor/${draft.id}/finalize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acceptedIndices: [1] }),
      }),
      { params: Promise.resolve({ id: draft.id }) },
    );
    expect(refinalizeRes.status).toBe(200);

    const res = await GET(getPdfRequest(draft.id), { params: Promise.resolve({ id: draft.id }) });
    expect(res.status).toBe(200);

    expect(pdf.htmlToPdf).toHaveBeenCalledTimes(1);
    const renderedHtml = pdf.htmlToPdf.mock.calls[0][0] as string;
    // Reflects the LAST finalize: extras accepted, summary reverted to base
    // (proving `structured` wasn't destroyed by the first finalize).
    const expectedHtml = renderCvHtml({ ...BASE_STORE, experience: TAILORED_STORE.experience });
    expect(renderedHtml).toBe(expectedHtml);
    expect(renderedHtml).toContain("Speaks English and Malay");
    expect(renderedHtml).not.toContain(TAILORED_STORE.summary);
  });

  it("ownership (Fable design review): B cannot fetch A's finalized PDF — 404", async () => {
    const { tailoredResumesRepo } = await import("@/server/persistence/repos/tailoredResumes");
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
      costUsd: 0.01,
      completedAt: new Date(),
    });
    await postFinalize(
      new NextRequest(`http://localhost/api/tailor/${draft.id}/finalize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acceptedIndices: [0] }),
      }),
      { params: Promise.resolve({ id: draft.id }) },
    );

    const [userB] = await state.testDb
      .insert(users)
      .values({ email: "user-b-tailor-pdf@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    requireUser.mockResolvedValue({ id: userB.id, email: userB.email, role: "user" });

    const res = await GET(getPdfRequest(draft.id), { params: Promise.resolve({ id: draft.id }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
    expect(pdf.htmlToPdf).not.toHaveBeenCalled();
  });
});
