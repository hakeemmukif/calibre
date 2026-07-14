import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { insertJob, insertJobScore, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { applications, jobs, jobScores, resumes, searchRuns, sources, tailoredResumes, users } from "@/server/persistence/schema";
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

const { GET, DELETE } = await import("./route");

function req(): NextRequest {
  return new NextRequest("http://localhost/api/jobs/anything");
}

describe("GET /api/jobs/:id", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  beforeEach(() => {
    requireUser.mockReset();
    requireUser.mockResolvedValue({ id: BOOTSTRAP_ADMIN_ID, email: "admin@example.com", role: "admin" });
  });

  afterEach(async () => {
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(searchRuns);
    await state.testDb.delete(sources);
    await state.testDb.delete(resumes);
  });

  it("401s with UNAUTHORIZED when there is no session", async () => {
    requireUser.mockRejectedValue(new UnauthorizedError());
    const res = await GET(req(), { params: Promise.resolve({ id: crypto.randomUUID() }) });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("returns 404 for a foreign-owned job id (cross-tenant isolation, no existence leak)", async () => {
    const [userB] = await state.testDb
      .insert(users)
      .values({ email: "user-b-jobs-id-route@example.com", passwordHash: "h", role: "user" })
      .returning();
    const source = await insertSource(state.testDb);
    const resume = await insertResume(state.testDb);
    const job = await insertJob(state.testDb, source.id);
    await insertJobScore(state.testDb, job.id, resume.id);

    requireUser.mockResolvedValue({ id: userB.id, email: userB.email, role: "user" });
    const res = await GET(req(), { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
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
  beforeEach(() => {
    requireUser.mockReset();
    requireUser.mockResolvedValue({ id: BOOTSTRAP_ADMIN_ID, email: "admin@example.com", role: "admin" });
  });

  afterEach(async () => {
    await state.testDb.delete(applications);
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(searchRuns);
    await state.testDb.delete(sources);
    await state.testDb.delete(resumes);
  });

  it("401s with UNAUTHORIZED when there is no session", async () => {
    requireUser.mockRejectedValue(new UnauthorizedError());
    const res = await DELETE(req(), { params: Promise.resolve({ id: crypto.randomUUID() }) });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("returns 404 for an unknown id", async () => {
    const res = await DELETE(req(), { params: Promise.resolve({ id: crypto.randomUUID() }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("returns 404 for a foreign-owned pasted job (cross-tenant isolation), row untouched", async () => {
    const [userB] = await state.testDb
      .insert(users)
      .values({ email: "user-b-jobs-id-delete@example.com", passwordHash: "h", role: "user" })
      .returning();
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { persona: "pasted" });

    requireUser.mockResolvedValue({ id: userB.id, email: userB.email, role: "user" });
    const res = await DELETE(req(), { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");

    const { eq } = await import("drizzle-orm");
    const [stillThere] = await state.testDb.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, job.id));
    expect(stillThere).toBeTruthy();
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
      userId: BOOTSTRAP_ADMIN_ID,
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
