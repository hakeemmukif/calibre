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
  tzRequirement: z.string().optional(),                                   // verbatim stated TZ/overlap requirement
  hiringStructure: z.enum(["local-entity", "eor", "contractor"]).optional(),
  workCalendar: z.string().optional(),                                    // stated calendar expectation (display-only)
});
export type JdFacts = z.infer<typeof JdFactsSchema>;

// gpt-oss-120b drops `.optional()` fields from json_schema output regardless of
// prompt wording (client.ts derives `required` from the Zod schema, strict:false).
// The emission schema forces every field present; emitToFacts then strips nulls
// back to undefined so the tolerant JdFactsSchema type is preserved.
export const JdFactsEmitSchema = z.object({
  title: z.string(),
  isJobPosting: z.boolean(),
  company: z.string().nullable(),
  seniority: z.string().nullable(),
  employmentType: z.string().nullable(),
  location: z.string().nullable(),
  remotePolicy: z.string().nullable(),
  hiringScope: z.enum(["anywhere", "restricted"]).nullable(),
  hiringCountries: z.array(z.string()).nullable(),
  mustHaves: z.array(z.string()),
  niceToHaves: z.array(z.string()),
  salaryRange: z.string().nullable(),
  responsibilities: z.array(z.string()),
  redFlags: z.array(z.string()),
  tzRequirement: z.string().nullable(),
  hiringStructure: z.enum(["local-entity", "eor", "contractor"]).nullable(),
  workCalendar: z.string().nullable(),
});
export type JdFactsEmit = z.infer<typeof JdFactsEmitSchema>;

// Null-strip boundary: emission output -> tolerant JdFacts. Dropping null-valued
// keys makes them `undefined`, which the `.optional()` parse-side fields accept
// (Zod `.optional()` rejects `null`), and keeps the url-check gate's `!company`
// check working when the model emits company: null.
export function emitToFacts(emit: JdFactsEmit): JdFacts {
  const stripped = Object.fromEntries(Object.entries(emit).filter(([, v]) => v !== null));
  return JdFactsSchema.parse(stripped);
}

export async function extractJdFacts(
  llm: LlmClient,
  description: string,
  signal?: AbortSignal,
): Promise<{ data: JdFacts; model: string; costUsd: number }> {
  const raw = await llm.complete({
    task: "jd-extract",
    messages: renderTemplate("jd-extract", { jobDescription: description }),
    responseSchema: JdFactsEmitSchema,
    signal,
  });
  return { ...raw, data: emitToFacts(raw.data) };
}

// Gate-only variant (url-check's runGate, run.ts) — NOT used by the scanned
// path above. Live testing (2026-07-13) found gpt-oss-120b reliably omits
// `.optional()` fields from json_schema structured output regardless of
// prompt wording, because client.ts's response_format derives `required`
// from the Zod schema and runs with `strict: false`. JdFactsEmitSchema makes
// every field required (scalars nullable) forcing the model to emit them
// explicitly. isJobPosting/company were verified 3/3 live (2026-07-13); the
// three remote-fit fields (tzRequirement/hiringStructure/workCalendar) are
// pending live verification. emitToFacts then strips nulls back to
// undefined so run.ts's `!company` check still holds and isJobPosting is
// always present at runtime.
export async function extractJdFactsForGate(
  llm: LlmClient,
  description: string,
): Promise<{ data: JdFacts; model: string; costUsd: number }> {
  const raw = await llm.complete({
    task: "jd-extract",
    messages: renderTemplate("jd-extract", { jobDescription: description }),
    responseSchema: JdFactsEmitSchema,
  });
  return { ...raw, data: emitToFacts(raw.data) };
}
