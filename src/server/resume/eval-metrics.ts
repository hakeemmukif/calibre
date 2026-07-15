// Pure, deterministic scoring for the résumé-extraction eval harness (Task 9).
// NO LLM, NO IO — every golden run in eval.live.test.ts calls REAL extraction
// first, then hands the resulting ResumeStore to these functions. Kept pure
// so the scoring itself is unit-tested in the normal (non-live) gate.
import type { ResumeStore } from "./resume-store";

// The extractor de-scrambles two-column layouts and strips trailing
// credentials (resume-extract.md's "Field-specific rules"), so an extracted
// value is often NOT an exact substring of rawText even when it is faithful
// — e.g. name "REDACTED_NAME" vs rawText "REDACTED_NAME, PMP". Token-level
// matching (every significant token of `needle` present in `haystack`,
// case/punctuation-insensitive) is what actually distinguishes a faithful
// de-scramble from a hallucination.
const STOPWORDS = new Set(["a", "an", "the", "of", "in", "at", "on", "and", "or", "to", "for", "with", "by"]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function significantTokens(s: string): string[] {
  return tokenize(s).filter((t) => (t.length > 1 || /^\d$/.test(t)) && !STOPWORDS.has(t));
}

// PDF text extraction sometimes fragments words with stray intra-word spaces
// (e.g. rawText "D esigned Web 3.0" for "Designed Web 3.0"), and the v2
// extractor correctly repairs these — so a faithful repaired token can fail
// exact whole-token membership against rawText's fragmented tokens. The
// alphanumeric blob substring fallback tolerates that split without
// loosening hallucination detection: it's gated to alphabetic tokens of
// length >= 4, so digits and short tokens (which would false-positive as a
// substring of nearly anything) still require exact token membership.
export function fuzzyContains(haystack: string, needle: string): boolean {
  const needleTokens = significantTokens(needle);
  if (needleTokens.length === 0) return true; // nothing significant to violate
  const haystackTokens = new Set(tokenize(haystack));
  const haystackBlob = haystack.toLowerCase().replace(/[^a-z0-9]/g, "");
  return needleTokens.every((t) => {
    if (haystackTokens.has(t)) return true;
    if (/^[a-z]+$/.test(t) && t.length >= 4 && haystackBlob.includes(t)) return true;
    return false;
  });
}

export interface ConceptRecall {
  found: number;
  total: number;
  recall: number;
}

// For each expected concept, is there a fuzzy match among the extracted
// items? Direction matters: haystack=extracted candidate, needle=expected —
// an expected item ("PMP") is typically a subset of the fuller extracted
// wording ("Project Management Professional (PMP)"), not the reverse.
export function conceptRecall(expected: string[], extracted: string[]): ConceptRecall {
  const total = expected.length;
  if (total === 0) return { found: 0, total: 0, recall: 1 }; // nothing expected = trivially satisfied
  const found = expected.filter((exp) => extracted.some((ext) => fuzzyContains(ext, exp))).length;
  return { found, total, recall: found / total };
}

export interface ExpectedDateAtom {
  start?: string | null;
  end?: string | null;
  isCurrent: boolean;
}

interface ActualDateAtom {
  start?: string;
  end?: string;
  isCurrent: boolean;
}

// undefined (store) and null (expected fixture literal) both mean "no atom"
// — normalize before comparing so fixtures can use either.
function normalizeAtom(v: string | null | undefined): string | undefined {
  return v ?? undefined;
}

export function dateAtomMatch(expected: ExpectedDateAtom, actual: ActualDateAtom): boolean {
  return (
    normalizeAtom(expected.start) === normalizeAtom(actual.start) &&
    normalizeAtom(expected.end) === normalizeAtom(actual.end) &&
    expected.isCurrent === actual.isCurrent
  );
}

// The text-path hallucination guard: every extracted scalar, experience/
// project bullet, and skill must fuzzy-trace back to rawText. Only
// meaningful for the text path (v0 scope — see eval.live.test.ts header for
// the vision deferral). Empty array = clean.
export function containmentViolations(store: ResumeStore, rawText: string): string[] {
  const violations: string[] = [];

  const scalars: Array<[string, string | undefined]> = [
    ["name", store.name],
    ["headline", store.headline],
    ["location", store.location],
    ["summary", store.summary],
  ];
  for (const [field, value] of scalars) {
    if (value !== undefined && !fuzzyContains(rawText, value)) {
      violations.push(`scalar:${field}: "${value}"`);
    }
  }

  store.experience.forEach((e, i) => {
    e.bullets.forEach((b) => {
      if (!fuzzyContains(rawText, b)) violations.push(`experience[${i}].bullets: "${b}"`);
    });
  });

  store.projects.forEach((p, i) => {
    p.bullets.forEach((b) => {
      if (!fuzzyContains(rawText, b)) violations.push(`projects[${i}].bullets: "${b}"`);
    });
  });

  store.skills.forEach((g, i) => {
    g.items.forEach((item) => {
      if (!fuzzyContains(rawText, item)) violations.push(`skills[${i}].items: "${item}"`);
    });
  });

  return violations;
}

export interface ExpectedRole {
  company: string;
  start?: string | null;
  end?: string | null;
  isCurrent: boolean;
}

export interface ExpectedGolden {
  name: string;
  headline?: string;
  location?: string;
  certifications: string[];
  languages: string[];
  projects: string[];
  skillsMin?: number;
  roles: ExpectedRole[];
}

export interface GoldenScore {
  scalarScore: number;
  recallScore: number;
  dateScore: number;
  containmentScore: number;
  aggregate: number;
}

// Averages only the sub-scores that had something to check — an empty
// `expected` array (e.g. no certifications) is trivially satisfied, not
// counted as a failure, so it must not be averaged in as a 0.
function average(scores: number[]): number {
  return scores.length === 0 ? 1 : scores.reduce((a, b) => a + b, 0) / scores.length;
}

function scoreScalars(expected: ExpectedGolden, store: ResumeStore): number {
  const checks: boolean[] = [fuzzyContains(store.name, expected.name)];
  if (expected.headline !== undefined) checks.push(fuzzyContains(store.headline ?? "", expected.headline));
  if (expected.location !== undefined) checks.push(fuzzyContains(store.location ?? "", expected.location));
  return checks.filter(Boolean).length / checks.length;
}

function scoreRecall(expected: ExpectedGolden, store: ResumeStore): number {
  const parts: number[] = [
    conceptRecall(expected.certifications, store.certifications.map((c) => c.name)).recall,
    conceptRecall(expected.languages, store.languages.map((l) => l.language)).recall,
    conceptRecall(expected.projects, store.projects.map((p) => p.name)).recall,
  ];
  if (expected.skillsMin !== undefined) {
    const extractedCount = store.skills.flatMap((g) => g.items).length;
    parts.push(Math.min(1, extractedCount / expected.skillsMin));
  }
  return average(parts);
}

function scoreDates(expected: ExpectedGolden, store: ResumeStore): number {
  if (expected.roles.length === 0) return 1;
  const matches = expected.roles.map((role) => {
    const entry = store.experience.find((e) => fuzzyContains(e.company, role.company));
    if (!entry) return false;
    return dateAtomMatch(role, entry);
  });
  return matches.filter(Boolean).length / matches.length;
}

// Weighting (v0 — the controller may retune after the first live run):
// recall (0.35) weighs heaviest because concept coverage is the primary
// extraction-quality signal; scalars (0.25) and dates (0.20) are narrower
// checks; containment (0.20) is binary (hallucination is a hard fail
// elsewhere in eval.live.test.ts — here it's folded into the aggregate too
// so a single golden's regression is visible in the trend, not just a
// separate assertion).
const WEIGHTS = { scalar: 0.25, recall: 0.35, date: 0.2, containment: 0.2 } as const;

export function scoreGolden(expected: ExpectedGolden, store: ResumeStore, rawText: string): GoldenScore {
  const scalarScore = scoreScalars(expected, store);
  const recallScore = scoreRecall(expected, store);
  const dateScore = scoreDates(expected, store);
  const containmentScore = containmentViolations(store, rawText).length === 0 ? 1 : 0;

  const aggregate =
    scalarScore * WEIGHTS.scalar +
    recallScore * WEIGHTS.recall +
    dateScore * WEIGHTS.date +
    containmentScore * WEIGHTS.containment;

  return { scalarScore, recallScore, dateScore, containmentScore, aggregate };
}

// Starting values — NOT yet calibrated against a real run (no
// OPENROUTER_API_KEY in this environment). The controller runs
// `npm run eval:resume` live, observes the actual aggregate across the
// golden set, and retunes these two constants: EVAL_BASELINE should land
// near the observed aggregate, EVAL_EPSILON is the tolerated regression
// before the suite fails.
export const EVAL_BASELINE = 0.85;
export const EVAL_EPSILON = 0.05;
