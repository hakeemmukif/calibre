// Clean TS port of career-ops/role-matcher.mjs `roleFuzzyMatch` (system-
// architecture.md §2 `server/score` row + §3: "role-matcher.mjs roleFuzzyMatch
// ... ported to TS"). The donor matches two title STRINGS pairwise; here the
// left-hand side is a `RoleTarget` (titles[] + keywords[] derived from the
// résumé), so the rule is applied PER TITLE — `target.titles.some(title =>
// ...)` — each comparison is between that single title's token set and the
// posting's token set. Thresholds: ≥1 non-baseline shared token, Jaccard
// ≥ 0.6. Deliberate deviation from the donor (spec 2026-07-16 §4.1): the
// donor's blanket ≥2-shared-tokens floor is dropped — it made every
// single-token role (Recruiter, Head of Finance → ["finance"]) unmatchable;
// a single shared NON-BASELINE token is real signal, and BASELINE_TOKENS
// already blocks the ["engineer"]-style collisions the floor existed for.
// Skill keywords widen the shared/non-baseline count (a keyword token that
// also appears in the posting counts toward both) but never enter the
// Jaccard union — pooling every title + every keyword into one token set
// (the previous approach) made the pool 20-50 tokens wide for a realistic
// résumé, which crushed the Jaccard ratio for every posting and neutered
// discovery entirely.
import type { ResumeRow } from "@/server/persistence/repos/resumes";
import type { RawPosting, RoleTarget } from "./connector";

// From career-ops/role-matcher.mjs — seniority/mode/location words that must
// not count as matching signal on their own. Deviations from the donor (spec
// 2026-07-16 §4.1): "staff" is removed — it is the function token of "Chief
// of Staff" ("chief"/"of" are glue), and Jaccard ≥ 0.6 still rejects
// "Staff <X>" seniority collisions; the last line adds the function-neutral
// glue words the ≥2-char tokenizer rule now admits.
const ROLE_STOPWORDS = new Set([
  "junior", "mid", "middle", "senior", "principal", "lead", "head",
  "chief", "associate", "intern", "entry", "level",
  // Abbreviated seniority + roman-numeral levels: the same glue as
  // "junior"/"senior"/"level" above, in the spellings the ≥2-char rule admits
  // ("Sr." → "sr", punctuation stripped before this filter). Without these,
  // "Sr. Software Engineer" / "Software Engineer II" stop matching "Software
  // Engineer" — the stray token breaks the all-baseline containment shortcut
  // and can never contribute overlap against a posting that lacks it. Capped
  // at "iv": levels past IV are vanishingly rare, and "v"/"i" are single-char
  // (already dropped) while longer numerals would start colliding with real
  // words.
  "sr", "jr", "ii", "iii", "iv",
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
  "of", "the", "and", "for", "to", "in", "at", "on",
]);

// Verbatim — generic role-altitude words; overlap in only these never counts
// as a match on its own.
export const BASELINE_TOKENS = new Set([
  "software", "engineer", "developer", "manager", "architect",
  "analyst", "designer", "consultant", "specialist",
  "platform", "systems", "services",
  "backend", "frontend", "full", "stack", "fullstack",
]);

/**
 * Strips punctuation ("Sr." → "sr", "Full-Stack" → "full"/"stack") and keeps
 * ANY token of ≥2 chars that is not a stopword. The donor's >3-char floor plus
 * a curated acronym allowlist is gone (spec 2026-07-16 §4.1): the floor dropped
 * CEO/CTO/VP/QA to [], and no allowlist can enumerate the short tokens real
 * résumés carry (ai, ml, aws, sql, seo, ...). So the filter is deliberately
 * permissive and ROLE_STOPWORDS is the ONLY thing keeping non-signal words out
 * — any short glue word admitted here must be added there.
 */
export function roleTokens(text: string): string[] {
  const value = typeof text === "string" ? text : String(text ?? "");
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !ROLE_STOPWORDS.has(w));
}

// --- Phrase path (stress-test report 2026-07-17 §6.1) -----------------------
// Measured over 2,906 live ATS postings × 40 role targets (2,008 oracle-labeled
// should-match pairs): the token rule alone scores recall 0.425 because real
// postings are written "<Role>, <Department/Geo/Program>" — the résumé title is
// FULLY contained, but the appended qualifier grows the Jaccard union to
// 0.50–0.25 ("Product Manager, Cash Platform" → J=0.50, rejected). The problem
// is asymmetric (résumé ⊂ posting), not proximity, so lowering the floor is the
// wrong lever: J≥0.5 buys +13.7pt recall for +120 cross-function FPs, J≥0.4 for
// +239 (report §6.2). Bag containment for all titles is worse still (FP 688 —
// "Chief of Staff" bag-matches 160 "Staff <X> Engineer" titles; §6.3).
// This path is ORed with the token rule: recall 0.425 → 0.722, FP 190 → 141.
//
// The phrase tokenizer is deliberately NOT `roleTokens`: word ORDER is the
// whole point here (it is what stops "Product Manager" matching "Product
// Marketing Manager"), so it keeps the raw sequence and drops only glue and
// seniority.
const PHRASE_GLUE = new Set(["of", "the", "and", "for", "to", "a", "an", "in", "at", "on", "with"]);
const PHRASE_SENIORITY = new Set(["senior", "sr", "junior", "jr", "principal", "lead", "intermediate", "ii", "iii", "iv"]);

// "developer" and "engineer" are the same role word across boards ("Backend
// Developer" ×23 on Bjak for a "Backend Engineer" résumé); folding them is the
// only synonym handled here. Broader synonymy (Talent Acquisition ↔ Recruiter,
// Accounting ↔ Accountant) needs vocabulary, not geometry — report §6.5.
function phraseTokens(text: string, fold: boolean): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !PHRASE_GLUE.has(w) && !PHRASE_SENIORITY.has(w))
    .map((w) => (fold && w === "developer" ? "engineer" : w));
}

/**
 * The title's token sequence must appear IN ORDER in the posting's, with
 * interposed posting tokens allowed only when they are BASELINE_TOKENS. The
 * skip admits "iOS **Software** Engineer" for an "iOS Engineer" résumé (~90 FNs
 * in the mobile family) while still rejecting "Product **Marketing** Manager"
 * for "Product Manager" — "marketing" is not baseline. ≥2 tokens: a single-token
 * title contained anywhere is the bag test's word-scatter failure.
 */
function phraseContained(title: string, postingTitle: string): boolean {
  const t = phraseTokens(title, true);
  if (t.length < 2) return false;
  const p = phraseTokens(postingTitle, true);

  for (let start = 0; start < p.length; start++) {
    if (p[start] !== t[0]) continue;
    let ti = 1;
    for (let pi = start + 1; pi < p.length && ti < t.length; pi++) {
      if (p[pi] === t[ti]) ti++;
      else if (!BASELINE_TOKENS.has(p[pi])) break;
    }
    if (ti === t.length) return true;
  }
  return false;
}

/**
 * Single-token, non-baseline titles (Recruiter, CEO, Accountant) can't use the
 * phrase test and sit under the Jaccard floor against any qualified posting
 * ("Senior Recruiter | Design" → J=0.33; recruiter recall was 0.00). English job
 * titles are head-final, so match the LAST token of the posting's first segment:
 * "Technical Recruiter" ✓, "GTM Recruiter, AMER" ✓, "CEO, Digital Insurer &
 * Takaful Operator (DITO)" ✓; "CEO Office - …" ✗, "Executive Assistant to CEO" ✗,
 * "Recruiting Coordinator" ✗. Not extended to 2-token titles: measured +96 FPs,
 * because heads like "Executive"/"Officer"/"Engineering" are not function words
 * on these boards ("Digital Marketing Executive") — report §6.4.
 */
function headNounMatch(title: string, postingTitle: string): boolean {
  const t = phraseTokens(title, false);
  if (t.length !== 1 || BASELINE_TOKENS.has(t[0])) return false;

  const segment = postingTitle.toLowerCase().split(/\s[-–—|]\s|[,|(/]/)[0];
  const head = phraseTokens(segment.split(/\bto\b/)[0], false);
  return head.length > 0 && head[head.length - 1] === t[0];
}

/**
 * ≥1 non-baseline shared token, Jaccard ≥ 0.6 — the donor's rule
 * (role-matcher.mjs `roleFuzzyMatch`) minus its blanket ≥2-shared-tokens
 * floor (spec 2026-07-16 §4.1: the floor made single-token roles like
 * Recruiter or Head of Finance → ["finance"] unmatchable; the
 * discriminating-token rule already blocks baseline-only collisions).
 * Applied pairwise between ONE title's token set and the posting's title
 * token set. `keywordTokens` (the résumé's skills) can add to the
 * shared/non-baseline overlap count — a keyword token only ever contributes
 * when it's already present in `postingSet`, so it never grows the Jaccard
 * union beyond `titleTokens ∪ postingTokens`.
 */
function titleMatchesPosting(
  title: string,
  keywordTokens: Set<string>,
  postingTitle: string,
  postingTokens: string[],
  postingSet: Set<string>,
): boolean {
  const titleTokens = [...new Set(roleTokens(title))];
  if (titleTokens.length === 0) return false;

  // Phrase path, ORed with the token rule below. It also subsumes the previous
  // all-baseline BAG-containment shortcut (report §6.1 rule 4: that shortcut
  // becomes the phrase test): "Full-Stack Engineer" is all-baseline, so the
  // discriminating-token rule can never fire from its own words and even a
  // literal "Full Stack Engineer" posting was rejected — `phraseContained` now
  // admits it for every title, not just all-baseline ones. The bag test is gone
  // rather than kept alongside: being word-order-blind it produced the 55
  // word-scatter FPs on one target alone ("Platform Engineer" ← "ML Engineer
  // Manager, AI Conversation Platform"). Cost of dropping it: 14 comma-INVERTED
  // hits ("Software Engineer, Frontend" for a "Frontend Engineer" résumé), which
  // the −56 FPs pay for. §6.5 flags segment rotation as the untested fix.
  if (phraseContained(title, postingTitle)) return true;
  if (headNounMatch(title, postingTitle)) return true;

  const titleTokenSet = new Set(titleTokens);
  const titleOverlap = titleTokens.filter((w) => postingSet.has(w));

  const keywordOverlap = [...keywordTokens].filter((w) => !titleTokenSet.has(w) && postingSet.has(w));
  const overlap = [...titleOverlap, ...keywordOverlap];

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

  return target.titles.some((title) =>
    titleMatchesPosting(title, keywordTokens, posting.title, postingTokens, postingSet),
  );
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

/**
 * Titles from `structured.experience[].title` + a best-effort headline
 * (`structured.headline`, else the most recent experience's title — same
 * precedence as `server/resume/derive-view.ts`, kept independent since this
 * is a best-effort search input, not the fail-loud wire-view boundary).
 * Keywords from `structured.skills`.
 */
export function deriveRoleTargets(resume: Pick<ResumeRow, "structured">, persona: "remote" | "local"): RoleTarget[] {
  const store = resume.structured;
  const headline = store.headline ?? store.experience[0]?.title;

  const titles = dedupePreserveOrder([...store.experience.map((e) => e.title), ...(headline ? [headline] : [])]);
  const keywords = dedupePreserveOrder(store.skills.flatMap((g) => g.items));

  return [{ titles, keywords, persona }];
}
