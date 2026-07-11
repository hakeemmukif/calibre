import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, requestJson, requestJsonOrNull } from "./http";

const Schema = z.object({ ok: z.boolean() });

function stubFetch(res: Response) {
  vi.stubGlobal("fetch", vi.fn(async () => res));
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  return p.then(() => null, (e) => e);
}

afterEach(() => vi.unstubAllGlobals());

describe("requestJson", () => {
  it("turns an empty-body 500 into a clean ApiError, not 'Unexpected end of JSON input'", async () => {
    stubFetch(new Response("", { status: 500 }));
    const err = await caught(requestJson("/x", undefined, Schema));
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).message).not.toMatch(/Unexpected end of JSON/i);
  });

  it("turns a non-JSON (HTML) error body into a clean ApiError, not a Zod/Syntax error", async () => {
    stubFetch(new Response("<html>500</html>", { status: 500, headers: { "content-type": "text/html" } }));
    const err = await caught(requestJson("/x", undefined, Schema));
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).code).toBe("INTERNAL");
  });

  it("preserves a well-formed ErrorEnvelope: code, message, details survive", async () => {
    const body = JSON.stringify({ error: { code: "CONFLICT", message: "already exists", details: { existingId: "abc" } } });
    stubFetch(new Response(body, { status: 409, headers: { "content-type": "application/json" } }));
    const err = await caught(requestJson("/x", undefined, Schema));
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).code).toBe("CONFLICT");
    expect((err as ApiError).message).toBe("already exists");
    expect((err as ApiError).details).toEqual({ existingId: "abc" });
  });

  it("parses a 2xx JSON body through the schema", async () => {
    stubFetch(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(requestJson("/x", undefined, Schema)).resolves.toEqual({ ok: true });
  });
});

describe("requestJsonOrNull", () => {
  it("resolves a 404 with an empty body to null (not a JSON parse crash)", async () => {
    stubFetch(new Response("", { status: 404 }));
    await expect(requestJsonOrNull("/x", undefined, Schema)).resolves.toBeNull();
  });

  it("resolves a 404 with an ErrorEnvelope body to null", async () => {
    const body = JSON.stringify({ error: { code: "NOT_FOUND", message: "nope" } });
    stubFetch(new Response(body, { status: 404, headers: { "content-type": "application/json" } }));
    await expect(requestJsonOrNull("/x", undefined, Schema)).resolves.toBeNull();
  });
});
