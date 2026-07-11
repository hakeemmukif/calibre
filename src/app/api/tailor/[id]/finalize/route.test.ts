import { NextRequest } from "next/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { insertJob, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { jobs, resumes, sources, tailoredResumes } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { POST } = await import("./route");

const BASE_STORE = {
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
  extras: [],
};

const TAILORED_STORE = { ...BASE_STORE, summary: "Backend engineer specializing in payments." };

const DIFF = [{ section: "summary", op: "modify" as const, before: BASE_STORE.summary, after: TAILORED_STORE.summary, reason: "sharper framing" }];

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

  afterEach(async () => {
    await state.testDb.delete(tailoredResumes);
    await state.testDb.delete(jobs);
    await state.testDb.delete(resumes);
    await state.testDb.delete(sources);
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
});
