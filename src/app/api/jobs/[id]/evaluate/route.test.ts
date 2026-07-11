import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { insertJob, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { jobs, jobScores, resumes, sources } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));
vi.mock("@/server/score/liveness", () => ({ probeLivenessDeep: vi.fn().mockResolvedValue("active") }));

const { POST } = await import("./route");

function req(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/jobs/${id}/evaluate`, { method: "POST" });
}

describe("POST /api/jobs/:id/evaluate", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(sources);
    await state.testDb.delete(resumes);
  });

  it("returns 404 NOT_FOUND for a malformed (non-uuid) id, never a 500", async () => {
    const id = "not-a-uuid";
    const res = await POST(req(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("returns 404 NOT_FOUND for an unknown (but well-formed) job id", async () => {
    const id = "00000000-0000-0000-0000-000000000000";
    const res = await POST(req(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("returns 409 CONFLICT when no résumé is active", async () => {
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { description: "Backend role at Acme." });

    const res = await POST(req(job.id), { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
  });

  it("returns 422 EXTRACTION_FAILED when the job has no description and none can be backfilled", async () => {
    vi.stubEnv("CALIBER_TEST_DOUBLES", "1");
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { description: null });
    await insertResume(state.testDb, { isActive: true });

    const res = await POST(req(job.id), { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("EXTRACTION_FAILED");
  });

  it("happy path: 200 with a Job.parse-valid body, and a job_scores row exists after", async () => {
    vi.stubEnv("CALIBER_TEST_DOUBLES", "1");
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { description: "Backend role at Acme." });
    await insertResume(state.testDb, { isActive: true });

    const res = await POST(req(job.id), { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(job.id);
    expect(body.applyUrl).toBeTruthy();

    const rows = await state.testDb.select().from(jobScores).where(eq(jobScores.jobId, job.id));
    expect(rows).toHaveLength(1);
  });
});
