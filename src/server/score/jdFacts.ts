// Stage 1 — JD facts extraction (system-architecture.md §2 "eval/run-staged.ts
// Stage 1 JdFacts extract"). Objective facts only, no fit judgement — that's
// Stage 2 (evalScores.ts). Fields mirror config/templates/jd-extract.md's
// instructions verbatim; every field but `title` is optional because the
// template is told to leave a field absent rather than guess.
import { z } from "zod";
import type { LlmClient } from "@/lib/llm/client";
import { renderTemplate } from "@/lib/llm/templates";

export const JdFactsSchema = z.object({
  title: z.string(),
  // Spec 2026-07-12 §6: the extract-gate. Optional so the shared
  // automated path (scoreTopCandidates) never fails JdFactsSchema.parse
  // when a cheap model omits it — required-at-the-boundary enforcement
  // lives in the url-check pipeline (run.ts), not here.
  isJobPosting: z.boolean().optional(),
  company: z.string().optional(),
  seniority: z.string().optional(),
  employmentType: z.string().optional(),
  location: z.string().optional(),
  remotePolicy: z.string().optional(),
  // Spec 2026-07-12 §5 Layer C: STATED hiring geography only — never guessed.
  hiringScope: z.enum(["anywhere", "restricted"]).optional(),
  hiringCountries: z.array(z.string()).optional(), // countries/regions verbatim as the JD states them
  mustHaves: z.array(z.string()),
  niceToHaves: z.array(z.string()),
  salaryRange: z.string().optional(),
  responsibilities: z.array(z.string()),
  redFlags: z.array(z.string()), // legitimacy-review signals (Block G input)
});
export type JdFacts = z.infer<typeof JdFactsSchema>;

export async function extractJdFacts(
  llm: LlmClient,
  description: string,
): Promise<{ data: JdFacts; model: string; costUsd: number }> {
  return llm.complete({
    task: "jd-extract",
    messages: renderTemplate("jd-extract", { jobDescription: description }),
    responseSchema: JdFactsSchema,
  });
}

// Gate-only variant (url-check's runGate, run.ts) — NOT used by the scanned
// path above. Live testing (2026-07-13) found gpt-oss-120b reliably omits
// `.optional()` fields from json_schema structured output regardless of
// prompt wording, because client.ts's response_format derives `required`
// from the Zod schema and runs with `strict: false`. Making isJobPosting
// required and company required-but-nullable forces the model to emit both
// explicitly (verified 3/3 live calls); JdFactsSchema itself stays optional
// so the scanned path (scoreTopCandidates) never fails to parse a cheap
// model's omission.
export const JdFactsGateSchema = JdFactsSchema.extend({
  isJobPosting: z.boolean(),
  company: z.string().nullable(),
});
export type JdFactsGate = z.infer<typeof JdFactsGateSchema>;

export async function extractJdFactsForGate(
  llm: LlmClient,
  description: string,
): Promise<{ data: JdFactsGate; model: string; costUsd: number }> {
  return llm.complete({
    task: "jd-extract",
    messages: renderTemplate("jd-extract", { jobDescription: description }),
    responseSchema: JdFactsGateSchema,
  });
}
