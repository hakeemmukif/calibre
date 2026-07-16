// Requirement-correlation regression harness (Task 12) — LIVE-LLM-GATED.
// Runs the REAL classify+verify path (classifyAndVerify, no DB) over every
// golden in __fixtures__/golden, then drives the REAL rewrite (the `tailor`
// task) against the same golden and asserts it never fabricates or regresses
// literal-ATS keyword presence.
//
// Gating mirrors src/server/resume/eval.live.test.ts (glob-based, not an env
// skipIf flag): the default vitest.config.ts excludes `src/**/*.live.test.ts`,
// so this file never runs under `npm test`/CI's default gate.
// vitest.smoke.config.ts's `include` covers the same pattern, so
// `npm run eval:tailor` (which passes `--config vitest.smoke.config.ts`)
// collects it — and inherits src/smoke/setup.ts's fail-loud precondition
// checks (OPENROUTER_API_KEY, DATABASE_URL, no CALIBER_TEST_DOUBLES) even
// though this suite itself never touches the DB.
//
// GROWTH RULE: every résumé/JD pair that gets misclassified in prod joins
// this golden set (src/server/tailor/__fixtures__/golden/).
//
// Run: OPENROUTER_API_KEY=... npm run eval:tailor
// Costs real tokens (correlate + tailor tasks, config/models.yml).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getLlm } from "@/lib/llm/client";
import type { ResumeStore } from "@/server/resume/resume-store";
import type { JdFacts } from "@/server/score/jdFacts";
import { classifyAndVerify } from "./correlate";
import {
  CORRELATE_BASELINE, CORRELATE_EPSILON, atsSignal, fabricationViolations,
  falseGapRate, statusAccuracy, verifyEvidence,
} from "./correlate-metrics";
import { applyEdits } from "./merge";
import { emitTailorRewrite } from "./index";

interface Golden {
  id: string;
  category: "real" | "synthetic";
  resume: ResumeStore;
  jdFacts: JdFacts;
  expected: { rows: { requirement: string; status: "met" | "buried" | "gap" }[] };
}

const DIR = join(__dirname, "__fixtures__", "golden");
const goldens: Golden[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(DIR, f), "utf8")) as Golden);

describe("requirement correlation eval (live)", () => {
  const accuracies: number[] = [];

  it.each(goldens.map((g) => [g.id, g] as const))(
    "%s: every met/buried cites verifiable evidence; statuses score acceptably",
    async (_id, g) => {
      const llm = getLlm();
      const rows = await classifyAndVerify(g.jdFacts, g.resume, llm);

      // fail-loud: verifyEvidence already downgrades an uncited/unverifiable
      // claim to `gap`, so any row that SURVIVES as met/buried must carry
      // non-null evidence — this is a guard against verifyEvidence itself
      // regressing, not a re-check of the classifier's honesty.
      for (const r of rows) {
        if (r.status !== "gap") expect(r.evidence, `${r.requirement} evidence`).toBeTruthy();
      }

      const actual = rows.map((r) => ({ requirement: r.requirement, status: r.status }));
      accuracies.push(statusAccuracy(g.expected.rows, actual));
      expect(falseGapRate(g.expected.rows, actual)).toBeLessThanOrEqual(0.25);

      // Rewrite non-regression: drive the real `tailor` task off this
      // golden's own classify+verify rows (mirrors runTailorJob's
      // candidates/gaps split, index.ts) and assert the rewrite (a) never
      // fabricates a number absent from the base résumé, and (b) never
      // makes a term that was literally ATS-present in the base résumé
      // disappear from the rewritten résumé.
      const candidates = rows
        .filter((r) => r.status !== "gap")
        .map((r) => ({ requirement: r.requirement, term: r.term, status: r.status, evidence: r.evidence, reason: r.reason }));
      const gaps = rows.filter((r) => r.status === "gap").map((r) => r.requirement);

      const rewrite = await emitTailorRewrite(llm, { resume: g.resume, candidates, gaps });

      const fabrications = fabricationViolations(rewrite.diff, g.resume);
      expect(fabrications, `fabricated number(s) in rewrite: ${JSON.stringify(fabrications)}`).toEqual([]);

      const rewritten = applyEdits(g.resume, rewrite.diff);
      const before = atsSignal(rows).present;
      const afterRows = verifyEvidence(rows.map(({ atsPresent: _atsPresent, ...r }) => r), rewritten);
      const after = atsSignal(afterRows).present;
      expect(after, "rewrite must never regress literal-ATS term presence").toBeGreaterThanOrEqual(before);
    },
    120000,
  );

  it("aggregate status accuracy meets the calibrated baseline", () => {
    expect(accuracies).toHaveLength(goldens.length);
    const mean = accuracies.reduce((a, b) => a + b, 0) / accuracies.length;
    expect(mean).toBeGreaterThanOrEqual(CORRELATE_BASELINE - CORRELATE_EPSILON);
  });
});
