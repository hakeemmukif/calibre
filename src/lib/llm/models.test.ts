import { describe, expect, it } from "vitest";
import type { TaskName } from "./client";
import { escalateModelFor, modelFor, priceFor } from "./models";

describe("models", () => {
  it("modelFor reads model/maxTokens/temperature from config/models.yml", () => {
    const config = modelFor("resume-extract");
    expect(config).toEqual({ model: "openai/gpt-4o-mini", maxTokens: 2000, temperature: 0.1 });
  });

  it("escalateModelFor returns the configured escalation model", () => {
    expect(escalateModelFor("match-score")).toBe("openai/gpt-4o");
  });

  it("escalateModelFor returns null when a task has no escalateTo", () => {
    expect(escalateModelFor("resume-extract")).toBeNull();
  });

  it("priceFor reads the prompt/completion price for a known model", () => {
    expect(priceFor("openai/gpt-4o-mini")).toEqual({ promptUsdPerMTok: 0.15, completionUsdPerMTok: 0.6 });
  });

  it("throws on an unknown task", () => {
    expect(() => modelFor("not-a-real-task" as TaskName)).toThrow(/unknown task/i);
  });

  it("throws when a model has no price entry", () => {
    expect(() => priceFor("openai/does-not-exist")).toThrow(/no price entry/i);
  });
});
