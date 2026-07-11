import { NextRequest } from "next/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { insertJob, insertJobScore, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { applications, jobs, jobScores, resumes, sources } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

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

  afterEach(async () => {
    await state.testDb.delete(applications);
    await state.testDb.delete(jobScores);
    await state.testDb.delete(jobs);
    await state.testDb.delete(resumes);
    await state.testDb.delete(sources);
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
    const app = await markApplied({ jobId: job.id });

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
    const app = await markApplied({ jobId: job.id });

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
});
