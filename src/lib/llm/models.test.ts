import { describe, expect, it } from "vitest";
import type { TaskName } from "./client";
import { escalateModelFor, modelFor, priceFor } from "./models";

describe("models", () => {
  it("modelFor reads model/maxTokens/temperature from config/models.yml", () => {
    const config = modelFor("resume-extract");
    expect(config).toEqual({ model: "openai/gpt-oss-120b", maxTokens: 6000, temperature: 0.1 });
  });

  it("escalateModelFor returns null for match-score (no escalation valve configured)", () => {
    expect(escalateModelFor("match-score")).toBeNull();
  });

  it("escalateModelFor returns null when a task has no escalateTo", () => {
    expect(escalateModelFor("resume-extract")).toBeNull();
  });

  it("priceFor reads the prompt/completion price for a known model", () => {
    expect(priceFor("openai/gpt-oss-120b")).toEqual({ promptUsdPerMTok: 0.03, completionUsdPerMTok: 0.15 });
  });

  it("throws on an unknown task", () => {
    expect(() => modelFor("not-a-real-task" as TaskName)).toThrow(/unknown task/i);
  });

  it("throws when a model has no price entry", () => {
    expect(() => priceFor("openai/does-not-exist")).toThrow(/no price entry/i);
  });

  it("modelFor reads url-check-search (perplexity/sonar, temperature 0)", () => {
    expect(modelFor("url-check-search")).toEqual({
      model: "perplexity/sonar",
      maxTokens: 4000,
      temperature: 0,
    });
  });

  it("priceFor reads the perplexity/sonar price entry", () => {
    expect(priceFor("perplexity/sonar")).toEqual({ promptUsdPerMTok: 1, completionUsdPerMTok: 1 });
  });

  it("modelFor reads ghost-web task config", () => {
    const config = modelFor("ghost-web");
    expect(config).toEqual({ model: "perplexity/sonar", maxTokens: 2000, temperature: 0 });
  });
});
