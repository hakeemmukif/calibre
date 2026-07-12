import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { profile } from "@/server/persistence/schema";
import { createTestDb, type TestDb } from "@/server/persistence/test-db";
import { Profile } from "@/types";

const state = vi.hoisted(() => ({ testDb: undefined as unknown as TestDb }));
vi.mock("@/server/persistence/db", () => ({ getDb: () => state.testDb }));

const { GET, PUT } = await import("./route");

function putRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/profile", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/profile", () => {
  beforeAll(async () => {
    state.testDb = await createTestDb();
  });

  afterEach(async () => {
    await state.testDb.delete(profile);
  });

  it("GET 404s with NOT_FOUND when unseeded (Resume absence pattern)", async () => {
    const res = await GET();
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("GET returns the seeded row as a valid Profile", async () => {
    await state.testDb.insert(profile).values({ id: "default", baseCountry: "MY", relocation: "stay" });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(() => Profile.parse(body)).not.toThrow();
    expect(body.relocation).toBe("stay");
  });

  it("PUT full-replaces and returns the updated Profile", async () => {
    await state.testDb.insert(profile).values({ id: "default", baseCountry: "MY", relocation: "stay" });
    const res = await PUT(putRequest({ baseCountry: "MY", relocation: "open" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Profile.parse(body).relocation).toBe("open");
  });

  it("PUT 422s on an invalid body", async () => {
    await state.testDb.insert(profile).values({ id: "default", baseCountry: "MY", relocation: "stay" });
    const res = await PUT(putRequest({ baseCountry: "Malaysia", relocation: "maybe" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("PUT 404s when the row is missing", async () => {
    const res = await PUT(putRequest({ baseCountry: "MY", relocation: "open" }));
    expect(res.status).toBe(404);
  });
});
