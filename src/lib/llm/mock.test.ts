import { describe, expect, it } from "vitest";
import { z } from "zod";
import { makeMockLlm } from "./mock";

const schema = z.object({ ok: z.boolean() });

describe("makeMockLlm", () => {
  it("returns scripted data validated against the caller's schema", async () => {
    const llm = makeMockLlm({ "resume-extract": { ok: true } });
    const result = await llm.complete({ task: "resume-extract", messages: [], responseSchema: schema });
    expect(result).toEqual({ data: { ok: true }, model: "mock", costUsd: 0 });
  });

  it("supports a function script keyed by call args", async () => {
    const llm = makeMockLlm(({ task }) => ({ ok: task === "jd-extract" }));
    const result = await llm.complete({ task: "jd-extract", messages: [], responseSchema: schema });
    expect(result.data).toEqual({ ok: true });
  });

  it("throws when canned data fails the caller's responseSchema", async () => {
    const llm = makeMockLlm({ "resume-extract": { ok: "not-a-boolean" } });
    await expect(llm.complete({ task: "resume-extract", messages: [], responseSchema: schema })).rejects.toThrow();
  });

  it("throws when no scripted response exists for the requested task", async () => {
    const llm = makeMockLlm({});
    await expect(llm.complete({ task: "tailor", messages: [], responseSchema: schema })).rejects.toThrow(
      /no scripted response/i,
    );
  });
});
