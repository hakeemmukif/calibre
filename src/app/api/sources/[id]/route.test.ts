import { NextRequest } from "next/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { insertSource } from "@/server/persistence/repos/__fixtures__/helpers";
import { sources } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { PATCH } = await import("./route");
const { GET } = await import("../route");

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/sources/x", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("PATCH /api/sources/:id", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  afterEach(async () => {
    await state.testDb.delete(sources);
  });

  it("flips enabled and a re-GET shows it persisted", async () => {
    await insertSource(state.testDb, { id: "greenhouse", name: "Greenhouse", persona: "remote", enabled: true });

    const res = await PATCH(jsonRequest({ enabled: false }), params("greenhouse"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("greenhouse");
    expect(body.enabled).toBe(false);

    const listRes = await GET();
    const listBody = await listRes.json();
    expect(listBody.items.find((s: { id: string }) => s.id === "greenhouse").enabled).toBe(false);
  });

  it("unknown id -> 404 NOT_FOUND", async () => {
    const res = await PATCH(jsonRequest({ enabled: true }), params("nope"));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("bad body ({enabled: 'yes'}) -> 422 VALIDATION_ERROR", async () => {
    await insertSource(state.testDb, { id: "greenhouse", name: "Greenhouse", persona: "remote", enabled: true });

    const res = await PATCH(jsonRequest({ enabled: "yes" }), params("greenhouse"));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("invalid JSON body -> 422 VALIDATION_ERROR", async () => {
    const req = new NextRequest("http://localhost/api/sources/x", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await PATCH(req, params("greenhouse"));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });
});
