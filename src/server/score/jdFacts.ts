// Stage 1 — JD facts extraction (system-architecture.md §2 "eval/run-staged.ts
// Stage 1 JdFacts extract"). Objective facts only, no fit judgement — that's
// Stage 2 (evalScores.ts). Fields mirror config/templates/jd-extract.md's
// instructions verbatim; every field but `title` is optional because the
// template is told to leave a field absent rather than guess.
import { z } from "zod";
import type { LlmClient } from "@/lib/llm/client";
import { renderTemplate } from "@/lib/llm/templates";
import { HiringStructure } from "@/types";

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
  // Spec 2026-07-14 §4: schedule + structure facts (STATED only, never guessed).
  tzRequirement: z.string().optional(), // verbatim stated overlap requirement, e.g. "4h overlap with PST"
  hiringStructure: HiringStructure.optional(), // "via Deel/EOR" | "B2B contract" | explicit contract-term role
  workCalendar: z.string().optional(), // stated calendar expectations — display only, no dial
  mustHaves: z.array(z.string()),
  niceToHaves: z.array(z.string()),
  salaryRange: z.string().optional(),
  responsibilities: z.array(z.string()),
  redFlags: z.array(z.string()), // legitimacy-review signals (Block G input)
});
export type JdFacts = z.infer<typeof JdFactsSchema>;

// The RESPONSE schema for EVERY jd-extract LLM call (spec 2026-07-14 §4). gpt-oss-120b
// drops `.optional()` fields under `strict:false`; making each field REQUIRED (nullable
// for scalars) forces emission. isJobPosting stays required non-null — it is the gate
// decision. Arrays stay required (model emits []). Parse-side JdFacts is unchanged; nulls
// normalize away at the boundary (normalizeEmission).
export const JdFactsEmissionSchema = z.object({
  title: z.string(),
  isJobPosting: z.boolean(),
  company: z.string().nullable(),
  seniority: z.string().nullable(),
  employmentType: z.string().nullable(),
  location: z.string().nullable(),
  remotePolicy: z.string().nullable(),
  hiringScope: z.enum(["anywhere", "restricted"]).nullable(),
  hiringCountries: z.array(z.string()),
  tzRequirement: z.string().nullable(),
  hiringStructure: HiringStructure.nullable(),
  workCalendar: z.string().nullable(),
  mustHaves: z.array(z.string()),
  niceToHaves: z.array(z.string()),
  salaryRange: z.string().nullable(),
  responsibilities: z.array(z.string()),
  redFlags: z.array(z.string()),
});
export type JdFactsEmission = z.infer<typeof JdFactsEmissionSchema>;

// null → undefined, so downstream (resolveEligibility, resolveTzBand, runGate) sees the
// tolerant optional shape it already expects.
export function normalizeEmission(raw: JdFactsEmission): JdFacts {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (v !== null) out[k] = v;
  return JdFactsSchema.parse(out);
}

// Gate return type: isJobPosting non-null boolean + company nullable (unchanged contract).
// Omit<JdFacts, "company"> rather than a plain intersection — JdFacts.company is
// `string | undefined`, and intersecting that with `string | null` collapses to plain
// `string` (the only overlap), silently dropping the null branch runGate depends on.
export type JdFactsGate = Omit<JdFacts, "company"> & { isJobPosting: boolean; company: string | null };

export async function extractJdFacts(
  llm: LlmClient,
  description: string,
): Promise<{ data: JdFacts; model: string; costUsd: number }> {
  const res = await llm.complete({
    task: "jd-extract",
    messages: renderTemplate("jd-extract", { jobDescription: description }),
    responseSchema: JdFactsEmissionSchema,
  });
  return { ...res, data: normalizeEmission(res.data) };
}

// Gate variant (url-check's runGate, run.ts) — sends the SAME emission schema as the
// scanned path above; isJobPosting/company are read straight off the raw response since
// the emission schema already guarantees the required shapes runGate depends on. Live
// testing (2026-07-13) found gpt-oss-120b reliably omits `.optional()` fields from
// json_schema structured output regardless of prompt wording, because client.ts's
// response_format derives `required` from the Zod schema and runs with `strict: false`.
export async function extractJdFactsForGate(
  llm: LlmClient,
  description: string,
): Promise<{ data: JdFactsGate; model: string; costUsd: number }> {
  const res = await llm.complete({
    task: "jd-extract",
    messages: renderTemplate("jd-extract", { jobDescription: description }),
    responseSchema: JdFactsEmissionSchema,
  });
  // isJobPosting is a real boolean (emission-required); company stays string|null.
  const data: JdFactsGate = { ...normalizeEmission(res.data), isJobPosting: res.data.isJobPosting, company: res.data.company };
  return { ...res, data };
}
