// Coarse function-tag classifier + write-back cache (arch §3.3/§9, plan P.4).
// A posting-intrinsic tag (not per-user): two deterministic tiers resolve the
// vast majority of postings for free — department-string match (primary),
// title-keyword match (fallback, also used when department is present but
// unmapped) — and only the residue that neither tier resolves pays for an
// LLM call, mirroring `correlate`'s task shape (`client.ts` TaskName +
// `config/models.yml` + `renderTemplate`). JD text never enters this module —
// it is stage-1 poison (measured 1,673 FPs) and the classifier's only inputs
// are title + department (arch §3 step 3 / this task's brief).
import { getLlm, type LlmClient } from "@/lib/llm/client";
import { renderTemplate } from "@/lib/llm/templates";
import { postingsRepo } from "@/server/persistence/repos/postings";
import { z } from "zod";

export const FUNCTION_TAGS = [
  "engineering",
  "product",
  "design",
  "data",
  "sales",
  "marketing",
  "customer-success",
  "people",
  "finance",
  "legal",
  "operations",
  "executive",
] as const;
export type FunctionTag = (typeof FUNCTION_TAGS)[number];

// Bumped whenever ANY tier's resolution logic changes (dept rules, title
// rules, or the LLM template) — drives the re-tag gate (arch §9): a posting
// whose `functionTagVersion` doesn't match this constant is re-classified
// from scratch, not read from cache. Format matches P.1's own test literal
// ("fc-v1", postings.test.ts) so the convention is set at this task, not
// improvised per-caller.
export const FUNCTION_CLASSIFIER_VERSION = "fc-v1";

// Ordered, first-match-wins. Applied identically to a department string and
// to a title — both are free text naming an org unit or a role, and the same
// coarse vocabulary describes either. Order encodes the deliberate tie-breaks
// for titles that carry two signals ("Sales Engineer" -> sales, checked
// before engineering; "Data Engineer" -> data, checked before engineering).
// Measured over the real 2,906-title live-titles.json corpus (title-only,
// since that fixture predates department plumbing): residue (neither tier
// fires) is 308/2906 (~10.6%) — see function.test.ts. This is a coverage-
// maximizing heuristic, not a proof of correctness: a title whose only
// keyword hit is a DOMAIN qualifier rather than its actual role word (e.g.
// "Senior Backend Engineer, Financial Markets" hits `finance` before
// `engineering` gets a chance) can resolve to the wrong tag without ever
// reaching the LLM tier. Accepted for v1 — same under/over-resolve judgment
// call as arch §4's dedup location-bucket; a perfect resolver needs the
// head-noun machinery `roleMatch.ts` already built for a different job
// (résumé-to-posting matching), not duplicated here.
const FUNCTION_KEYWORD_RULES: readonly [FunctionTag, RegExp][] = [
  ["legal", /legal|compliance|counsel|paralegal/i],
  ["people", /people|\bhr\b|human resources|talent|recruit|onboarding/i],
  ["finance", /financ|accounting|account(?:ant|ing)|payroll|controller|treasury|\btax\b|fp&a|billing/i],
  ["sales", /sales|business development|\bbdr\b|\bsdr\b|account (?:executive|manager)|partnership|channel|solutions? consult/i],
  ["marketing", /marketing|growth|brand|communications|\bpr\b|content|seo|demand gen|social media/i],
  ["customer-success", /customer (?:success|support|experience|service|care)|client success/i],
  ["design", /design|\bux\b|\bui\b|user experience|user research/i],
  ["data", /\bdata\b|analytics|\bbi\b\W|machine learning|\bml\b|\bscientist\b/i],
  ["product", /\bproduct\b/i],
  ["engineering", /engineer|develop|\bit\b|information technology|security|infrastructure|technical|software|architect|devops|\bsre\b|\bqa\b|quality assurance/i],
  ["operations", /operations|\bops\b|admin|facilities|logistics|supply chain|procurement/i],
  ["executive", /executive|leadership|\bceo\b|\bcoo\b|\bcfo\b|\bcto\b|chief|president|founder|vice president|\bvp\b|director/i],
];

function matchFunctionKeywords(text: string): FunctionTag | null {
  for (const [tag, pattern] of FUNCTION_KEYWORD_RULES) {
    if (pattern.test(text)) return tag;
  }
  return null;
}

// Two-tier deterministic resolution (plan P.4 goal 1): department-mapped
// primary, title-keyword fallback — used both when department is absent AND
// when it's present but unmapped (a deliberate widening past the plan's
// literal "title fallback when department is absent": an org's custom
// department string that matches none of our keywords still gets a shot at
// the title before falling through to the LLM residue). Returns null when
// NEITHER tier resolves — the caller's cue to pay for the LLM tier.
export function resolveFunctionTag(input: { department: string | null; title: string }): FunctionTag | null {
  const department = input.department?.trim();
  if (department) {
    const fromDept = matchFunctionKeywords(department);
    if (fromDept) return fromDept;
  }
  return matchFunctionKeywords(input.title);
}

// LLM tier (plan P.4 goal 2) — mirrors `correlate`'s task shape exactly:
// TaskName in client.ts, a config/models.yml block, a renderTemplate
// template. FunctionClassifyResultSchema's single field is required (not
// `.optional()`) — the schema-required lesson (client.ts derives json_schema
// `required` from Zod, and gpt-oss-120b silently omits any field absent from
// that list no matter how the prompt insists): an omitted `functionTag` here
// throws in `responseSchema.parse` (client.ts:127) rather than defaulting.
export const FunctionClassifyResultSchema = z.object({
  functionTag: z.enum(FUNCTION_TAGS),
});

export async function classifyFunctionTag(
  input: { title: string; department: string | null },
  llm: LlmClient,
): Promise<FunctionTag> {
  const messages = renderTemplate("function-classify", {
    title: input.title,
    department: input.department ?? "(none)",
  });
  const { data } = await llm.complete({
    task: "function-classify",
    messages,
    responseSchema: FunctionClassifyResultSchema,
  });
  return data.functionTag;
}

export interface FunctionTagDeps {
  llm?: LlmClient;
}

// Write-back cache (plan P.4 goal 3) + classifier-version re-tag gate (arch
// §9): a posting already tagged at the CURRENT classifier version reads the
// cache for free (no DB write, no LLM call). Anything else — never tagged,
// or tagged at a stale version — is resolved fresh (deterministic tiers
// first, LLM only for residue) and the verdict is persisted via
// `setFunctionTag` before returning, so every later caller (any user's scan,
// P.5) hits the cache. The crawler pays nothing: this only ever runs at
// scan-time, on survivors of stage-1, per arch §3 step 3.
export async function ensureFunctionTag(
  posting: { id: string; title: string; department: string | null; functionTag: string | null; functionTagVersion: string | null },
  deps: FunctionTagDeps = {},
): Promise<FunctionTag> {
  if (posting.functionTag && posting.functionTagVersion === FUNCTION_CLASSIFIER_VERSION) {
    return posting.functionTag as FunctionTag;
  }
  const resolved = resolveFunctionTag(posting);
  const tag = resolved ?? (await classifyFunctionTag(posting, deps.llm ?? getLlm()));
  await postingsRepo.setFunctionTag(posting.id, tag, FUNCTION_CLASSIFIER_VERSION);
  return tag;
}
