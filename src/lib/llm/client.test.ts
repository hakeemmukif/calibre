import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => {
  const create = vi.fn();
  const instances: Array<{ baseURL: string; apiKey: string }> = [];
  class FakeOpenAI {
    chat = { completions: { create } };
    constructor(opts: { baseURL: string; apiKey: string }) {
      instances.push(opts);
    }
  }
  return { create, instances, FakeOpenAI };
});

vi.mock("openai", () => ({ default: mocks.FakeOpenAI }));

const { getLlm } = await import("./client");

const schema = z.object({ ok: z.boolean() });

function reply(body: unknown, usage = { prompt_tokens: 1000, completion_tokens: 500 }) {
  return { choices: [{ message: { content: JSON.stringify(body) } }], usage };
}

describe("getLlm", () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.instances.length = 0;
    delete process.env.OPENROUTER_API_KEY;
  });

  it("throws if OPENROUTER_API_KEY is unset", () => {
    expect(() => getLlm()).toThrow(/OPENROUTER_API_KEY/);
  });

  it("wires baseURL and apiKey to OpenRouter", () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    getLlm();
    expect(mocks.instances.at(-1)).toEqual({ baseURL: "https://openrouter.ai/api/v1", apiKey: "test-key" });
  });

  it("sends a response_format json_schema derived from the Zod schema", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    mocks.create.mockResolvedValue(reply({ ok: true }));
    const llm = getLlm();

    await llm.complete({ task: "resume-extract", messages: [{ role: "user", content: "hi" }], responseSchema: schema });

    const callArgs = mocks.create.mock.calls[0][0];
    expect(callArgs.response_format.type).toBe("json_schema");
    expect(callArgs.response_format.json_schema.schema).toEqual(z.toJSONSchema(schema));
  });

  it("Zod-parses a valid reply and returns it as data", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    mocks.create.mockResolvedValue(reply({ ok: true }));
    const llm = getLlm();

    const result = await llm.complete({ task: "resume-extract", messages: [], responseSchema: schema });

    expect(result.data).toEqual({ ok: true });
    expect(result.model).toBe("openai/gpt-4o-mini");
  });

  it("throws when the reply fails the caller's responseSchema", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    mocks.create.mockResolvedValue(reply({ ok: "not-a-boolean" }));
    const llm = getLlm();

    await expect(llm.complete({ task: "resume-extract", messages: [], responseSchema: schema })).rejects.toThrow();
  });

  it("computes costUsd from usage x price", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    mocks.create.mockResolvedValue(reply({ ok: true }, { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }));
    const llm = getLlm();

    const result = await llm.complete({ task: "resume-extract", messages: [], responseSchema: schema });

    // openai/gpt-4o-mini: promptUsdPerMTok 0.15, completionUsdPerMTok 0.6
    expect(result.costUsd).toBeCloseTo(0.15 + 0.6, 10);
  });

  it("modelOverride overrides the task's base model in the outgoing request and result", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    mocks.create.mockResolvedValue(reply({ ok: true }));
    const llm = getLlm();

    const result = await llm.complete({
      task: "match-score",
      modelOverride: "openai/gpt-4o",
      messages: [],
      responseSchema: schema,
    });

    const callArgs = mocks.create.mock.calls[0][0];
    expect(callArgs.model).toBe("openai/gpt-4o");
    expect(result.model).toBe("openai/gpt-4o");
  });
});

describe("getLlm test-doubles seam", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the scripted mock when CALIBER_TEST_DOUBLES=1 (no API key needed)", async () => {
    vi.stubEnv("CALIBER_TEST_DOUBLES", "1");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const { getLlm } = await import("./client");
    const client = getLlm();
    const res = await client.complete({ task: "jd-extract", messages: [], responseSchema: z.any() });
    expect(res.model).toBe("mock");
  });

  it("throws on an unexpected flag value (fail loud)", async () => {
    vi.stubEnv("CALIBER_TEST_DOUBLES", "yes");
    const { getLlm } = await import("./client");
    expect(() => getLlm()).toThrow(/CALIBER_TEST_DOUBLES/);
  });
});
