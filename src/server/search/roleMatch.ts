// Clean TS port of career-ops/role-matcher.mjs `roleFuzzyMatch` (system-
// architecture.md §2 `server/score` row + §3: "role-matcher.mjs roleFuzzyMatch
// ... ported to TS"). The donor matches two title STRINGS pairwise; here the
// left-hand side is a `RoleTarget` (titles[] + keywords[] derived from the
// résumé), so the rule is applied PER TITLE — `target.titles.some(title =>
// ...)` — each comparison is between that single title's token set and the
// posting's token set, keeping the exact thresholds (≥2 shared tokens, ≥1
// non-baseline shared token, Jaccard ≥ 0.6). Skill keywords widen the
// shared/non-baseline count (a keyword token that also appears in the
// posting counts toward both) but never enter the Jaccard union — pooling
// every title + every keyword into one token set (the previous approach)
// made the pool 20-50 tokens wide for a realistic résumé, which crushed the
// Jaccard ratio for every posting and neutered discovery entirely.
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

/**
 * ≥2 shared tokens, ≥1 non-baseline shared token, Jaccard ≥ 0.6 — donor's
 * rule (role-matcher.mjs `roleFuzzyMatch`), applied pairwise between ONE
 * title's token set and the posting's title token set. `keywordTokens` (the
 * résumé's skills) can add to the shared/non-baseline overlap count — a
 * keyword token only ever contributes when it's already present in
 * `postingSet`, so it never grows the Jaccard union beyond `titleTokens ∪
 * postingTokens`.
 */
function titleMatchesPosting(
  title: string,
  keywordTokens: Set<string>,
  postingTokens: string[],
  postingSet: Set<string>,
): boolean {
  const titleTokens = [...new Set(roleTokens(title))];
  if (titleTokens.length === 0) return false;

  const titleTokenSet = new Set(titleTokens);
  const titleOverlap = titleTokens.filter((w) => postingSet.has(w));

  // Exact-role containment, scoped to ALL-BASELINE résumé titles: a title like
  // "Full-Stack Engineer" tokenizes entirely to BASELINE_TOKENS, so the
  // discriminating-token rule can never fire from its own words and even a
  // posting titled literally "Full Stack Engineer" is rejected (observed live:
  // Stripe's exact posting rejected for this résumé). For such titles only,
  // full containment of the (>=2-token) title in the posting is accepted,
  // shortcutting the discriminating and Jaccard rules. Domain-flavored titles
  // keep the donor's strict path — the existing negative tests pin that.
  // Deliberate deviation from the donor rule, scoped to all-baseline
  // containment only.
  const allBaseline = titleTokens.every((w) => BASELINE_TOKENS.has(w));
  if (allBaseline && titleTokens.length >= 2 && titleOverlap.length === titleTokens.length) return true;

  const keywordOverlap = [...keywordTokens].filter((w) => !titleTokenSet.has(w) && postingSet.has(w));
  const overlap = [...titleOverlap, ...keywordOverlap];
  if (overlap.length < 2) return false;

  const discriminating = overlap.filter((w) => !BASELINE_TOKENS.has(w));
  if (discriminating.length === 0) return false;

  const union = new Set([...titleTokens, ...postingTokens]).size;
  return overlap.length / union >= 0.6;
}

export function roleFuzzyMatch(target: RoleTarget, posting: RawPosting): boolean {
  const postingTokens = [...new Set(roleTokens(posting.title))];
  if (postingTokens.length === 0) return false;

  const postingSet = new Set(postingTokens);
  const keywordTokens = new Set(target.keywords.flatMap((keyword) => roleTokens(keyword)));

  return target.titles.some((title) => titleMatchesPosting(title, keywordTokens, postingTokens, postingSet));
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
