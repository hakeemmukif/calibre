// Stage 2 — match-score + Block G legitimacy (system-architecture.md §2
// "Stage 2 EvalScores with shouldEscalate -> stronger model, global =
// weighted_mean - red_flag_penalty; Block G = legitimacy_tier +
// legitimacy_signals inside EvalScores — no separate verdict module").
// `EvalScoresSchema` is shaped to supply everything `assembleJob` needs for
// a valid frozen `Job`: score, verdict, why, breakdown/fit/gaps/reasons, plus
// the donor 3(+1)-tier legitimacy block `server/score/legitimacy.ts` combines
// with liveness into the frozen 5-tier. Escalation itself is owned by the
// CALLER (server/score/index.ts) per the task brief — this module only
// performs one `complete()` call per invocation.
import { z } from "zod";
import type { LlmClient } from "@/lib/llm/client";
import { renderTemplate } from "@/lib/llm/templates";
import { Tone } from "@/types";

// Donor 3-tier (system-architecture.md §1) + the template's explicit `Scam`
// output — reconciled into the frozen 5-tier by `legitimacy.ts`.
export const DonorLegitimacyTier = z.enum(["High Confidence", "Caution", "Suspicious", "Scam"]);
export type DonorLegitimacyTier = z.infer<typeof DonorLegitimacyTier>;

export const EvalLegitimacySchema = z.object({
  tier: DonorLegitimacyTier,
  summary: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  signals: z.array(z.string()),
  // Model-asserted corroboration signal — the only path to the frozen
  // `verified` tier (system-architecture.md §1: "reserved for corroborated
  // signals"); never inferred from "High Confidence" alone.
  corroborated: z.boolean().optional(),
});

export const EvalScoresSchema = z.object({
  score: z.number().min(0).max(5),
  verdict: z.enum(["Apply", "Consider", "Research first", "Skip"]),
  why: z.string(), // frozen Job.why — short one-line rationale
  breakdown: z.array(
    z.object({
      label: z.string(),
      value: z.number(),
      display: z.string().optional(),
      tone: Tone.optional(),
    }),
  ),
  fit: z.array(z.object({ k: z.string(), v: z.string() })),
  gaps: z.array(z.object({ tone: z.enum(["warn", "ok"]), k: z.string(), v: z.string() })),
  reasons: z.object({ for: z.array(z.string()), against: z.array(z.string()) }),
  legitimacy: EvalLegitimacySchema,
  // The template's escalation signal (task brief: "match-score has a
  // lowConfidence output field intended as the escalation signal") — owning
  // the re-run decision is server/score/index.ts's job, not this schema.
  lowConfidence: z.boolean(),
});
export type EvalScores = z.infer<typeof EvalScoresSchema>;

export async function scoreMatch(
  llm: LlmClient,
  vars: { jdFacts: unknown; resume: unknown },
  modelOverride?: string,
): Promise<{ data: EvalScores; model: string; costUsd: number }> {
  return llm.complete({
    task: "match-score",
    modelOverride,
    messages: renderTemplate("match-score", {
      jdFacts: JSON.stringify(vars.jdFacts),
      resume: JSON.stringify(vars.resume),
    }),
    responseSchema: EvalScoresSchema,
  });
}
