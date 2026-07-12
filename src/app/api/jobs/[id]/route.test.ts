import { NextRequest } from "next/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { insertJob, insertJobScore, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { applications, jobs, jobScores, resumes, searchRuns, sources, tailoredResumes } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { GET, DELETE } = await import("./route");

function req(): NextRequest {
  return new NextRequest("http://localhost/api/jobs/anything");
}

describe("GET /api/jobs/:id", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  afterEach(async () => {
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(searchRuns);
    await state.testDb.delete(sources);
    await state.testDb.delete(resumes);
  });

  it("returns the frozen Job for a known id", async () => {
    const source = await insertSource(state.testDb);
    const resume = await insertResume(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    await insertJobScore(state.testDb, job.id, resume.id);

    const res = await GET(req(), { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(job.id);
    expect(body.applyUrl).toBeTruthy();
  });

  it("returns 404 for an unknown id", async () => {
    const res = await GET(req(), { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("returns 404 NOT_FOUND for a malformed (non-uuid) id, never a 500", async () => {
    const res = await GET(req(), { params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });
});

describe("DELETE /api/jobs/:id", () => {
  afterEach(async () => {
    await state.testDb.delete(applications);
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(searchRuns);
    await state.testDb.delete(sources);
    await state.testDb.delete(resumes);
  });

  it("returns 404 for an unknown id", async () => {
    const res = await DELETE(req(), { params: Promise.resolve({ id: crypto.randomUUID() }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("returns 404 NOT_FOUND for a malformed (non-uuid) id", async () => {
    const res = await DELETE(req(), { params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("returns 409 CONFLICT for a non-pasted job", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { persona: "remote" });

    const res = await DELETE(req(), { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
  });

  it("returns 409 CONFLICT for a pasted job with a tracked application", async () => {
    const source = await insertSource(state.testDb);
    const resume = await insertResume(state.testDb);
    const job = await insertJob(state.testDb, source.id, { persona: "pasted" });
    await insertJobScore(state.testDb, job.id, resume.id);
    await state.testDb.insert(applications).values({
      jobId: job.id,
      resumeId: resume.id,
      stage: 0,
      statusLabel: "Applied",
      statusTone: "good",
      note: "",
    });

    const res = await DELETE(req(), { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toMatch(/tracked application/);
  });

  it("returns 204 and removes the job for a pasted job with no application", async () => {
    const source = await insertSource(state.testDb);
    const resume = await insertResume(state.testDb);
    const job = await insertJob(state.testDb, source.id, { persona: "pasted" });
    await insertJobScore(state.testDb, job.id, resume.id);

    const res = await DELETE(req(), { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(204);

    const getRes = await GET(req(), { params: Promise.resolve({ id: job.id }) });
    expect(getRes.status).toBe(404);
  });
});
