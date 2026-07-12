import { NextRequest } from "next/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { urlChecksRepo } from "@/server/persistence/repos/urlChecks";
import { urlChecks } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { GET } = await import("./route");

function req(): NextRequest {
  return new NextRequest("http://localhost/api/jobs/check/anything");
}

describe("GET /api/jobs/check/:id", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  afterEach(async () => {
    await state.testDb.delete(urlChecks);
  });

  it("returns the UrlCheck row for a known id", async () => {
    const row = await urlChecksRepo.insert({
      url: "https://example.com/job/1",
      dedupeKey: "example.com/job/1",
      status: "queued",
      stage: null,
      jobId: null,
      alreadyKnown: false,
      needsText: false,
      error: null,
      costUsd: 0,
      raw: {},
    });

    const res = await GET(req(), { params: Promise.resolve({ id: row.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(row.id);
    expect(body.status).toBe("queued");
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
