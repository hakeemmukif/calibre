// Seam test (task-B6 fix pass, finding 1): catches the schema/template/
// contract vocabulary drift WITHOUT a real LLM call. Before the fix,
// `EvalLegitimacySchema.tier` was the donor vocabulary
// (["High Confidence","Caution","Suspicious","Scam"]) while both the frozen
// `LegitimacyTier` contract and config/templates/match-score.md's prose
// already used the 5-tier vocabulary — a real LLM response validating
// against the donor enum would throw and every run.ts per-job catch would
// swallow it silently (scored:0 in production, invisible in mocked tests).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LlmClient } from "@/lib/llm/client";
import type { ResumeMetrics } from "@/server/resume/resume-metrics";
import { LegitimacyTier } from "@/types";
import { EvalLegitimacySchema, scoreMatch } from "./evalScores";

describe("EvalScoresSchema legitimacy tier vocabulary", () => {
  it("the schema's tier enum is exactly the frozen LegitimacyTier contract", () => {
    // RED (pre-fix): EvalLegitimacySchema.tier.options was
    // ["High Confidence","Caution","Suspicious","Scam"] !== LegitimacyTier's
    // ["verified","clear","suspicious","ghost","scam"] — this assertion fails.
    // GREEN (post-fix): EvalLegitimacySchema.tier IS the imported
    // LegitimacyTier, so the options arrays are identical.
    expect(EvalLegitimacySchema.shape.tier.options).toEqual(LegitimacyTier.options);
  });

  it("match-score.md's tier prose references exactly the frozen tier tokens, no more, no fewer", () => {
    const templatePath = join(process.cwd(), "config", "templates", "match-score.md");
    const template = readFileSync(templatePath, "utf-8");

    const tierLine = template.match(/tier: one of([^\n]*)/);
    expect(tierLine).not.toBeNull();

    const tokens = [...tierLine![1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    // RED (pre-fix): the template already listed the 5-tier tokens, so this
    // half passed even before the fix — the schema mismatch above is what
    // makes the pair a seam: either one drifting from `LegitimacyTier` fails.
    expect(new Set(tokens)).toEqual(new Set(LegitimacyTier.options));
  });
});

describe("scoreMatch", () => {
  it("renders the résumé metrics into the match-score prompt as ground truth", async () => {
    // Fixed literal (task-11 brief): a real computeResumeMetrics(now=...)
    // would work too, but a literal keeps this assertion free of any
    // currentTenureMonths time-dependence.
    const metrics: ResumeMetrics = {
      totalYearsExperience: 5.5,
      currentTenureMonths: 18,
      roleCount: 3,
      durationDerivedRoleCount: 3,
      avgTenureMonths: 22,
      distinctSkillCount: 12,
      certificationCount: 1,
      languageCount: 2,
      quantifiedBulletRatio: 0.4,
    };

    let capturedMessages: { role: string; content: string }[] = [];
    const llm: LlmClient = {
      async complete(args) {
        capturedMessages = args.messages;
        return {
          data: args.responseSchema.parse({
            score: 4,
            verdict: "Apply",
            why: "Good fit.",
            breakdown: [],
            fit: [],
            gaps: [],
            reasons: { for: [], against: [] },
            legitimacy: { tier: "clear", summary: "Fine.", signals: [] },
            lowConfidence: false,
          }),
          model: "mock",
          costUsd: 0,
        };
      },
    };

    await scoreMatch(llm, { jdFacts: { title: "Engineer" }, resume: { name: "Jane" }, metrics });

    const rendered = capturedMessages.map((m) => m.content).join("\n");
    expect(rendered).toContain(JSON.stringify(metrics));
  });
});
