import { describe, expect, it } from "vitest";
import { getLlm } from "@/lib/llm/client"; // ensures "correlate" is a valid TaskName at type-check
import { modelFor } from "@/lib/llm/models";
import { renderTemplate } from "@/lib/llm/templates";

describe("correlate template + model", () => {
  it("renders with requirements and resume", () => {
    const msgs = renderTemplate("correlate", {
      requirements: JSON.stringify([{ id: 0, kind: "must", text: "distributed systems" }]),
      resume: JSON.stringify({ name: "A" }),
    });
    expect(msgs.some((m) => m.content.includes("distributed systems"))).toBe(true);
    expect(msgs[0].role).toBe("system");
  });
  it("has a model config", () => {
    expect(modelFor("correlate").model).toBe("openai/gpt-oss-120b");
  });
  it("getLlm is defined", () => {
    expect(getLlm).toBeTypeOf("function");
  });
});
