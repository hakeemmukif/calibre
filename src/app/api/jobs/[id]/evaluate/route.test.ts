import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";
import { UnauthorizedError } from "@/server/auth/errors";
import { insertJob, insertProfile, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { jobs, jobScores, resumes, sources, users } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));
vi.mock("@/server/score/liveness", () => ({ probeLivenessDeep: vi.fn().mockResolvedValue("active") }));

const { requireUser } = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/server/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/server/auth/session")>()),
  requireUser: () => requireUser(),
}));

const { POST } = await import("./route");
const { probeLivenessDeep } = await import("@/server/score/liveness");

function req(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/jobs/${id}/evaluate`, { method: "POST" });
}

describe("POST /api/jobs/:id/evaluate", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
    await insertProfile(state.testDb); // scoreJob's Layer-C refresh requires the operator profile
  });

  beforeEach(() => {
    requireUser.mockReset();
    requireUser.mockResolvedValue({ id: BOOTSTRAP_ADMIN_ID, email: "admin@example.com", role: "admin" });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(sources);
    await state.testDb.delete(resumes);
  });

  it("401s with UNAUTHORIZED when there is no session", async () => {
    requireUser.mockRejectedValue(new UnauthorizedError());
    const id = crypto.randomUUID();
    const res = await POST(req(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("returns 404 NOT_FOUND for a foreign-owned job id (cross-tenant isolation)", async () => {
    const [userB] = await state.testDb
      .insert(users)
      .values({ email: "user-b-evaluate-route@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { description: "Backend role at Acme." });
    await insertResume(state.testDb, { isActive: true });

    requireUser.mockResolvedValue({ id: userB.id, email: userB.email, role: "user" });
    const res = await POST(req(job.id), { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
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

  it("an unexpected throw returns 500 INTERNAL with a generic message — the internal error text never reaches the body", async () => {
    vi.stubEnv("CALIBER_TEST_DOUBLES", "1");
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { description: "Backend role at Acme." });
    await insertResume(state.testDb, { isActive: true });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(probeLivenessDeep).mockRejectedValueOnce(new Error("pg driver: connection reset (secret detail)"));

    const res = await POST(req(job.id), { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).toBe("Internal error.");
    expect(JSON.stringify(body)).not.toContain("secret detail");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("a broke non-admin user returns 402 INSUFFICIENT_CREDITS with feature/required/balance details", async () => {
    const [user] = await state.testDb
      .insert(users)
      .values({ email: "credits-402-evaluate@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    await insertProfile(state.testDb, { id: "profile-credits-402-evaluate", userId: user.id });
    const source = await insertSource(state.testDb);
    const job = await insertJob(state.testDb, source.id, { userId: user.id, description: "Backend role at Acme." });
    await insertResume(state.testDb, { userId: user.id, isActive: true });
    requireUser.mockResolvedValue({ id: user.id, email: user.email, role: "user" });

    const res = await POST(req(job.id), { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error.code).toBe("INSUFFICIENT_CREDITS");
    expect(body.error.details).toEqual({ feature: "evaluate", required: 5, balance: 0 });
  });
});
