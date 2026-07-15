import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { insertJob, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { jobs, resumes, sources, tailoredResumes, users } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";
import { UnauthorizedError } from "@/server/auth/errors";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { requireUser } = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/server/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/server/auth/session")>()),
  requireUser: () => requireUser(),
}));

const { POST } = await import("./route");

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
  experience: [],
  education: [],
  skills: [{ label: "Languages", items: ["TypeScript"] }],
  projects: [],
  certifications: [],
  languages: [],
  sections: [],
};

const TAILORED_STORE = { ...BASE_STORE, summary: "Backend engineer specializing in payments." };

const DIFF = [
  {
    section: "summary", op: "modify" as const, before: BASE_STORE.summary, after: TAILORED_STORE.summary,
    reason: "sharper framing", requirement: "payments framing",
    target: { index: null, bulletIndex: null },
  },
];

function postRequest(id: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/tailor/${id}/finalize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/tailor/:id/finalize", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  beforeEach(() => {
    requireUser.mockReset();
    requireUser.mockResolvedValue({ id: BOOTSTRAP_ADMIN_ID, email: "admin@example.com", role: "admin" });
  });

  afterEach(async () => {
    await state.testDb.delete(tailoredResumes);
    await state.testDb.delete(jobs);
    await state.testDb.delete(resumes);
    await state.testDb.delete(sources);
  });

  it("401s with UNAUTHORIZED when there is no session", async () => {
    requireUser.mockRejectedValue(new UnauthorizedError());
    const id = crypto.randomUUID();
    const res = await POST(postRequest(id, { acceptedIndices: [] }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("unknown id -> 404 NOT_FOUND", async () => {
    const id = "00000000-0000-0000-0000-000000000000";
    const res = await POST(postRequest(id, { acceptedIndices: [] }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("a malformed (non-uuid) id returns 404 NOT_FOUND, never a 500", async () => {
    const id = "not-a-uuid";
    const res = await POST(postRequest(id, { acceptedIndices: [] }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("409 RUN_NOT_READY before completion", async () => {
    const { tailoredResumesRepo } = await import("@/server/persistence/repos/tailoredResumes");
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

    const res = await POST(postRequest(draft.id, { acceptedIndices: [] }), { params: Promise.resolve({ id: draft.id }) });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("RUN_NOT_READY");
  });

  it("200: applies only the accepted subset", async () => {
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

    const res = await POST(postRequest(draft.id, { acceptedIndices: [0] }), { params: Promise.resolve({ id: draft.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resume.summary).toBe(TAILORED_STORE.summary);
  });

  it("empty JSON body -> 422 VALIDATION_ERROR", async () => {
    const id = "00000000-0000-0000-0000-000000000000";
    const req = new NextRequest(`http://localhost/api/tailor/${id}/finalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req, { params: Promise.resolve({ id }) });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("ownership (Fable design review): B cannot finalize A's tailor run — 404, row unchanged", async () => {
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
    const [userB] = await state.testDb
      .insert(users)
      .values({ email: "user-b-tailor-finalize@example.com", passwordHash: "h", role: "user" })
      .returning();
    requireUser.mockResolvedValue({ id: userB.id, email: userB.email, role: "user" });

    const res = await POST(postRequest(draft.id, { acceptedIndices: [0] }), { params: Promise.resolve({ id: draft.id }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");

    const stillUnfinalized = await tailoredResumesRepo.getById(draft.id, BOOTSTRAP_ADMIN_ID);
    expect(stillUnfinalized?.finalizedAt).toBeNull();
  });
});
