import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ shouldFail: false }));
vi.mock("@/server/persistence/db", () => ({
  getDb: () => ({
    run: async () => {
      if (state.shouldFail) throw new Error("db gone");
      return { rowsAffected: 0 };
    },
  }),
}));

import { GET } from "./route";

const originalKey = process.env.OPENROUTER_API_KEY;
afterAll(() => {
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
});

beforeEach(() => {
  state.shouldFail = false;
  delete process.env.OPENROUTER_API_KEY;
});

describe("GET /api/health", () => {
  it("reports llmKeyConfigured: false when the key is absent", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, llmKeyConfigured: false });
  });

  it("reports llmKeyConfigured: true on key PRESENCE only — no LLM call", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    const res = await GET();
    expect((await res.json()).llmKeyConfigured).toBe(true);
  });

  it("503s ok:false when the db ping throws", async () => {
    state.shouldFail = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET();
    expect(res.status).toBe(503);
    expect((await res.json()).ok).toBe(false);
    spy.mockRestore();
  });
});
