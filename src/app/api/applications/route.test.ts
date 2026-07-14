import { NextRequest } from "next/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { insertJob, insertJobScore, insertResume, insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { applications, jobs, jobScores, resumes, sources } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { POST, GET } = await import("./route");

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/applications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/applications${query}`);
}

async function setupScoredJob() {
  const source = await insertSource(state.testDb);
  // insertReplacingActive (not the raw insertResume fixture) — setupScoredJob
  // is called more than once per test in some cases, and the migration's
  // resumes_user_id_active_unique partial index now rejects a second
  // isActive:true row for the same user; insertReplacingActive clamps to one
  // active résumé the same way the real write path does.
  const { createResumesRepo } = await import("@/server/persistence/repos/resumes");
  const resume = await createResumesRepo(state.testDb).insertReplacingActive({
    userId: BOOTSTRAP_ADMIN_ID,
    rawText: "Jane Doe — Software Engineer",
    structured: {
      name: "Jane Doe",
      contact: [{ label: "email", value: "jane@example.com" }],
      summary: "Backend engineer.",
      experience: [],
      education: [],
      skills: [],
      extras: [],
    },
    sourceKind: "paste",
    isActive: true,
  });
  const job = await insertJob(state.testDb, source.id);
  await insertJobScore(state.testDb, job.id, resume.id);
  return { job, resume };
}

describe("POST /api/applications", () => {
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

  it("unknown jobId -> 404 NOT_FOUND", async () => {
    const res = await POST(jsonRequest({ jobId: crypto.randomUUID() }));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("no active résumé -> 409 CONFLICT", async () => {
    const source = await insertSource(state.testDb);
    const resume = await insertResume(state.testDb, { isActive: false });
    const job = await insertJob(state.testDb, source.id);
    await insertJobScore(state.testDb, job.id, resume.id);

    const res = await POST(jsonRequest({ jobId: job.id }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
  });

  it("existing but unscored job -> 409 CONFLICT, no orphaned row (not in GET)", async () => {
    const source = await insertSource(state.testDb);
    await insertResume(state.testDb, { isActive: true });
    const job = await insertJob(state.testDb, source.id);
    // deliberately no insertJobScore — job exists but is unscored

    const res = await POST(jsonRequest({ jobId: job.id }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");

    const listRes = await GET(getRequest(""));
    expect(listRes.status).toBe(200);
    expect((await listRes.json()).items).toHaveLength(0);
  });

  it("happy path -> 201 with a stage-0 Application", async () => {
    const { job } = await setupScoredJob();

    const res = await POST(jsonRequest({ jobId: job.id, note: "referred" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.jobId).toBe(job.id);
    expect(body.stage).toBe(0);
    expect(body.statusLabel).toBe("Applied");
    expect(body.statusTone).toBe("good");
    expect(body.note).toBe("referred");
  });

  it("duplicate jobId -> 409 CONFLICT with details.existingId", async () => {
    const { job } = await setupScoredJob();

    const first = await POST(jsonRequest({ jobId: job.id }));
    const firstBody = await first.json();

    const res = await POST(jsonRequest({ jobId: job.id }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.details.existingId).toBe(firstBody.id);
  });

  it("invalid JSON body -> 422 VALIDATION_ERROR", async () => {
    const req = new NextRequest("http://localhost/api/applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("missing jobId -> 422 VALIDATION_ERROR", async () => {
    const res = await POST(jsonRequest({}));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("a non-uuid jobId in the body returns 422 VALIDATION_ERROR, never a 500", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/applications", {
        method: "POST",
        body: JSON.stringify({ jobId: "abc" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /api/applications", () => {
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

  it("filters by stage/statusTone and pages with a cursor", async () => {
    const { job: jobA } = await setupScoredJob();
    const { job: jobB } = await setupScoredJob();
    await POST(jsonRequest({ jobId: jobA.id }));
    await POST(jsonRequest({ jobId: jobB.id }));

    const res = await GET(getRequest("?stage=0&statusTone=good&limit=1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).not.toBeNull();

    const res2 = await GET(getRequest(`?stage=0&statusTone=good&limit=1&cursor=${body.nextCursor}`));
    const body2 = await res2.json();
    expect(body2.items).toHaveLength(1);
    expect(body2.items[0].id).not.toBe(body.items[0].id);
    expect(body2.nextCursor).toBeNull();
  });

  it("unknown query parameter -> 422 VALIDATION_ERROR", async () => {
    const res = await GET(getRequest("?bogus=1"));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("a malformed cursor returns 422 VALIDATION_ERROR, never a 500", async () => {
    const res = await GET(getRequest("?cursor=@@bad@@"));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });
});
