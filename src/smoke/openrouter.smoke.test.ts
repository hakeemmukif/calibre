// Real-OpenRouter smoke: catches drift the mocked LLM client can't — model
// routing (config/models.yml), response-schema shape mismatches, and cost
// blowups. Costs real tokens; see src/smoke/setup.ts for the fail-loud gate.
import { describe, expect, it } from "vitest";
import { getLlm } from "@/lib/llm/client";
import { modelFor } from "@/lib/llm/models";
import { extractJdFacts } from "@/server/score/jdFacts";
import { scoreMatch } from "@/server/score/evalScores";

const FIXTURE_JD = `
Senior Backend Engineer — Acme Logistics (Remote, APAC timezones, full-time)
5+ years Node.js and Postgres experience required.
Must-have: TypeScript, distributed systems, API design.
Nice-to-have: Kubernetes, Go.
Salary: RM12,000–RM16,000/month.
Responsibilities: own the search-ingestion pipeline, mentor two juniors, ship weekly.
Apply via our careers page at acmelogistics.com/careers.
`.trim();

const FIXTURE_RESUME = {
  summary: "Backend engineer, 6 years Node.js/Postgres, led a search-ingestion migration.",
};

describe("openrouter smoke", () => {
  it("jd-extract: real completion Zod-parses, routes to the configured model, costs a sane amount", async () => {
    const llm = getLlm();
    const { data, model, costUsd } = await extractJdFacts(llm, FIXTURE_JD);

    expect(data.title).toBeTruthy();
    expect(model).toBe(modelFor("jd-extract").model);
    expect(costUsd).toBeGreaterThan(0);
    expect(costUsd).toBeLessThan(0.05);
  });

  it("match-score: real completion Zod-parses, routes to the configured model, costs a sane amount", async () => {
    const llm = getLlm();
    const { data: jdFacts } = await extractJdFacts(llm, FIXTURE_JD);
    const { data, model, costUsd } = await scoreMatch(llm, { jdFacts, resume: FIXTURE_RESUME });

    expect(data.verdict).toBeTruthy();
    expect(model).toBe(modelFor("match-score").model);
    expect(costUsd).toBeGreaterThan(0);
    expect(costUsd).toBeLessThan(0.05);
  });
});
