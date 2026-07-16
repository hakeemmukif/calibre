import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { insertJob, insertJobScore, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { applications, jobs, jobScores, resumes, sources, users } from "@/server/persistence/schema";
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

const { PATCH } = await import("./route");
const { markApplied } = await import("@/server/tracker");

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/applications/x", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("PATCH /api/applications/:id", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  beforeEach(() => {
    requireUser.mockReset();
    requireUser.mockResolvedValue({ id: BOOTSTRAP_ADMIN_ID, email: "admin@example.com", role: "admin" });
  });

  afterEach(async () => {
    await state.testDb.delete(applications);
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(resumes);
    await state.testDb.delete(sources);
  });

  it("401s with UNAUTHORIZED when there is no session", async () => {
    requireUser.mockRejectedValue(new UnauthorizedError());
    const res = await PATCH(jsonRequest({ note: "x" }), params(crypto.randomUUID()));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("empty patch -> 422 VALIDATION_ERROR", async () => {
    const res = await PATCH(jsonRequest({}), params(crypto.randomUUID()));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("unknown id -> 404 NOT_FOUND", async () => {
    const res = await PATCH(jsonRequest({ note: "x" }), params(crypto.randomUUID()));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("a malformed (non-uuid) id returns 404 NOT_FOUND, never a 500", async () => {
    const res = await PATCH(jsonRequest({ note: "x" }), params("not-a-uuid"));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("happy path: stage move re-folds status -> 200", async () => {
    const source = await insertSource(state.testDb);
    const resume = await insertResume(state.testDb, { isActive: true });
    const job = await insertJob(state.testDb, source.id);
    await insertJobScore(state.testDb, job.id, resume.id);
    const app = await markApplied(BOOTSTRAP_ADMIN_ID, { jobId: job.id });

    const res = await PATCH(jsonRequest({ stage: 2 }), params(app.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stage).toBe(2);
    expect(body.statusLabel).toBe("Interviewing");
    expect(body.statusTone).toBe("good");
  });

  it("explicit statusTone/statusLabel override wins over the stage-move re-fold", async () => {
    const source = await insertSource(state.testDb);
    const resume = await insertResume(state.testDb, { isActive: true });
    const job = await insertJob(state.testDb, source.id);
    await insertJobScore(state.testDb, job.id, resume.id);
    const app = await markApplied(BOOTSTRAP_ADMIN_ID, { jobId: job.id });

    const res = await PATCH(
      jsonRequest({ stage: 3, statusLabel: "Offer", statusTone: "verified" }),
      params(app.id),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.statusLabel).toBe("Offer");
    expect(body.statusTone).toBe("verified");
  });

  it("invalid JSON body -> 422 VALIDATION_ERROR", async () => {
    const req = new NextRequest("http://localhost/api/applications/x", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await PATCH(req, params(crypto.randomUUID()));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("by-uuid PATCH leak fix (Fable design review, CRITICAL): B cannot PATCH A's application — 404, row unchanged", async () => {
    const source = await insertSource(state.testDb);
    const resume = await insertResume(state.testDb, { isActive: true });
    const job = await insertJob(state.testDb, source.id);
    await insertJobScore(state.testDb, job.id, resume.id);
    const app = await markApplied(BOOTSTRAP_ADMIN_ID, { jobId: job.id, note: "original note" });

    const [userB] = await state.testDb
      .insert(users)
      .values({ email: "user-b-applications-patch-route@example.com", passwordHash: "h", role: "user", plan: "standard" })
      .returning();
    requireUser.mockResolvedValue({ id: userB.id, email: userB.email, role: "user" });

    const res = await PATCH(jsonRequest({ stage: 3, statusLabel: "Offer", note: "hijacked" }), params(app.id));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");

    // Row unchanged — re-query directly (not through the scoped repo, which
    // would just confirm the same scoping we're testing).
    const [stillThere] = await state.testDb.select().from(applications).where(eq(applications.id, app.id));
    expect(stillThere.stage).toBe(0);
    expect(stillThere.statusLabel).toBe("Applied");
    expect(stillThere.note).toBe("original note");
  });
});
