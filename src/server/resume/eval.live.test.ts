// Résumé-extraction regression harness (Task 9, v0) — LIVE-LLM-GATED.
// Runs REAL text-path extraction (getLlm(), no mocks/scripted fixtures) over
// every golden in __fixtures__/golden and asserts extraction quality.
//
// Gating mirrors the existing src/smoke/*.smoke.test.ts convention (glob-
// based, not an env skipIf flag): the default vitest.config.ts EXCLUDES
// `src/**/*.live.test.ts` (alongside the pre-existing `*.smoke.test.ts`
// exclude), so this file never runs under `npm test`/CI's default gate.
// vitest.smoke.config.ts's `include` was extended with the same
// `src/**/*.live.test.ts` pattern, so `npm run eval:resume` (which passes
// `--config vitest.smoke.config.ts`) collects it — and inherits
// src/smoke/setup.ts's fail-loud precondition checks (OPENROUTER_API_KEY,
// DATABASE_URL, no CALIBER_TEST_DOUBLES) even though this suite itself never
// touches the DB; that's a side effect of reusing the smoke config wholesale
// rather than forking a third config.
//
// GROWTH RULE: every résumé that fails in prod joins this golden set
// (extract its rawText via extractText, label `expected` from the failure,
// commit as a new __fixtures__/golden/*.json). The set only grows.
//
// v0 SCOPE = TEXT PATH ONLY. No image-only/vision golden: the containment
// guardrail (containmentViolations) is text-path-inherent — an image-only
// résumé has no rawText to fuzzy-contain against. Vision eval is a
// follow-up, not in scope here.
//
// Run: OPENROUTER_API_KEY=... npm run eval:resume
// Costs real tokens (gpt-oss-120b, resume-extract task, config/models.yml).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getLlm } from "@/lib/llm/client";
import { renderTemplate } from "@/lib/llm/templates";
import { emitToStore, ResumeStoreEmitSchema } from "./resume-store";
import { containmentViolations, scoreGolden, EVAL_BASELINE, EVAL_EPSILON, type ExpectedGolden } from "./eval-metrics";

interface Golden {
  id: string;
  category: "real" | "synthetic";
  rawText: string;
  expected: ExpectedGolden;
}

const GOLDEN_DIR = join(__dirname, "__fixtures__", "golden");

function loadGoldens(): Golden[] {
  return readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(GOLDEN_DIR, f), "utf8")) as Golden);
}

describe("résumé extraction eval (live)", () => {
  const goldens = loadGoldens();
  const aggregates: number[] = [];

  it.each(goldens.map((g) => [g.id, g] as const))(
    "%s: real text-path extraction is clean and scores acceptably",
    async (_id, golden) => {
      const llm = getLlm();
      const result = await llm.complete({
        task: "resume-extract",
        messages: renderTemplate("resume-extract", { rawText: golden.rawText }),
        responseSchema: ResumeStoreEmitSchema,
      });
      const store = emitToStore(result.data, "text");

      const violations = containmentViolations(store, golden.rawText);
      expect(violations, `hallucinated content not in rawText: ${JSON.stringify(violations)}`).toEqual([]);

      const score = scoreGolden(golden.expected, store, golden.rawText);
      aggregates.push(score.aggregate);
    },
    120000,
  );

  it("aggregate across all goldens meets the calibrated baseline", () => {
    // Populated by the it.each cases above, which vitest runs before this
    // one (declaration order within the same describe block).
    expect(aggregates).toHaveLength(goldens.length);
    const mean = aggregates.reduce((a, b) => a + b, 0) / aggregates.length;
    expect(mean).toBeGreaterThanOrEqual(EVAL_BASELINE - EVAL_EPSILON);
  });
});
