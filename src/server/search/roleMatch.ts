// Clean TS port of career-ops/role-matcher.mjs `roleFuzzyMatch` (system-
// architecture.md §2 `server/score` row + §3: "role-matcher.mjs roleFuzzyMatch
// ... ported to TS"). Donor matches two title STRINGS pairwise; here the
// left-hand side is a `RoleTarget` (titles[] + keywords[] derived from the
// résumé), so the rule is generalized to token-SET vs token-SET while keeping
// the exact thresholds: ≥2 shared tokens, ≥1 non-baseline shared token,
// Jaccard ≥ 0.6.
import type { ResumeRow } from "@/server/persistence/repos/resumes";
import type { RawPosting, RoleTarget } from "./connector";

// Verbatim from career-ops/role-matcher.mjs — seniority/mode/location words
// that must not count as matching signal on their own.
const ROLE_STOPWORDS = new Set([
  "junior", "mid", "middle", "senior", "staff", "principal", "lead", "head",
  "chief", "associate", "intern", "entry", "level",
  "remote", "hybrid", "onsite", "contract", "contractor", "freelance",
  "fulltime", "parttime", "permanent", "temporary", "internship",
  "role", "position", "opportunity", "team", "based",
  "bangalore", "bengaluru", "mumbai", "delhi", "hyderabad", "pune", "chennai",
  "london", "berlin", "paris", "madrid", "barcelona", "amsterdam", "dublin",
  "york", "francisco", "seattle", "boston", "austin", "chicago", "toronto",
  "tokyo", "singapore", "sydney", "melbourne", "lisbon", "warsaw",
  "europe", "emea", "apac", "latam", "americas", "india", "spain", "germany",
  "france", "italy", "canada", "brazil", "mexico", "japan",
  "with", "from", "into", "over", "this", "that",
]);

// Verbatim — short specialty acronyms kept despite their length.
const SHORT_SPECIALTY = new Set([
  "api", "sre", "sdk", "cli", "gpu", "cpu",
  "ios", "qa", "ux", "ui", "ar", "vr",
  "ocr", "crm", "erp",
]);

// Verbatim — generic role-altitude words; overlap in only these never counts
// as a match on its own.
export const BASELINE_TOKENS = new Set([
  "software", "engineer", "developer", "manager", "architect",
  "analyst", "designer", "consultant", "specialist",
  "platform", "systems", "services",
  "backend", "frontend", "full", "stack", "fullstack",
]);

export function roleTokens(text: string): string[] {
  const value = typeof text === "string" ? text : String(text ?? "");
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => (w.length > 3 || SHORT_SPECIALTY.has(w)) && !ROLE_STOPWORDS.has(w));
}

function targetTokenSet(target: RoleTarget): Set<string> {
  const tokens = new Set<string>();
  for (const title of target.titles) for (const tok of roleTokens(title)) tokens.add(tok);
  for (const keyword of target.keywords) for (const tok of roleTokens(keyword)) tokens.add(tok);
  return tokens;
}

/**
 * ≥2 shared tokens, ≥1 non-baseline shared token, Jaccard ≥ 0.6 — donor's
 * rule (role-matcher.mjs `roleFuzzyMatch`), applied between the résumé-
 * derived target's token pool (titles + keywords) and the posting's title.
 */
export function roleFuzzyMatch(target: RoleTarget, posting: RawPosting): boolean {
  const targetTokens = [...targetTokenSet(target)];
  const postingTokens = [...new Set(roleTokens(posting.title))];
  if (targetTokens.length === 0 || postingTokens.length === 0) return false;

  const postingSet = new Set(postingTokens);
  const overlap = targetTokens.filter((w) => postingSet.has(w));
  if (overlap.length < 2) return false;

  const discriminating = overlap.filter((w) => !BASELINE_TOKENS.has(w));
  if (discriminating.length === 0) return false;

  const union = new Set([...targetTokens, ...postingTokens]).size;
  return overlap.length / union >= 0.6;
}

function dedupePreserveOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

const HEADLINE_LABEL_RE = /headline|title|role/i;

/**
 * Titles from `structured.experience[].title` + a best-effort headline
 * (contact line matching headline/title/role, else the most recent
 * experience's title — same precedence as `server/resume/derive-view.ts`,
 * kept independent since this is a best-effort search input, not the
 * fail-loud wire-view boundary). Keywords from `structured.skills`.
 */
export function deriveRoleTargets(resume: Pick<ResumeRow, "structured">, persona: "remote" | "local"): RoleTarget[] {
  const store = resume.structured;
  const headline = store.contact.find((c) => HEADLINE_LABEL_RE.test(c.label))?.value ?? store.experience[0]?.title;

  const titles = dedupePreserveOrder([...store.experience.map((e) => e.title), ...(headline ? [headline] : [])]);
  const keywords = dedupePreserveOrder(store.skills.flatMap((g) => g.items));

  return [{ titles, keywords, persona }];
}
