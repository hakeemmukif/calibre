// English-first MVP reject gate — dependency-free heuristic. All validated
// samples (extraction model + pdf.js CJK text handling) are English; Bahasa
// Malaysia / bilingual CN-EN résumés are unvalidated, so we detect and reject
// them loudly rather than silently mis-structure them.

export class NonEnglishResumeError extends Error {
  constructor(
    message = "Caliber currently supports English-language résumés only — this résumé appears to be in another " +
      "language. Support for more languages is coming.",
  ) {
    super(message);
    this.name = "NonEnglishResumeError";
  }
}

// WHY these thresholds: an MVP heuristic tuned to pass a normal English
// résumé comfortably and reject the two shapes we know we can't handle yet
// (CJK script, Bahasa Malaysia). Revisit as the golden set grows.
const NON_LATIN_RATIO_THRESHOLD = 0.3;
const MIN_LENGTH_FOR_WORD_CHECK = 200;
const MIN_ENGLISH_WORD_HITS = 3;

const ALPHA_RE = /\p{L}/u;
const LATIN_RE = /\p{Script=Latin}/u;

function nonLatinRatio(text: string): number {
  let alphabetic = 0;
  let nonLatin = 0;
  for (const ch of text) {
    if (!ALPHA_RE.test(ch)) continue;
    alphabetic++;
    if (!LATIN_RE.test(ch)) nonLatin++;
  }
  return alphabetic === 0 ? 0 : nonLatin / alphabetic;
}

const ENGLISH_FUNCTION_WORDS = [
  "the", "and", "of", "to", "in", "for", "with", "a", "an", "is", "as", "at", "on", "or", "from", "by",
  "experience", "skills", "education", "work", "university", "project", "developer", "engineer", "manager", "team",
];

function englishWordHitCount(text: string): number {
  let hits = 0;
  for (const word of ENGLISH_FUNCTION_WORDS) {
    if (new RegExp(`\\b${word}\\b`, "i").test(text)) hits++;
  }
  return hits;
}

export function assertEnglish(text: string): void {
  if (nonLatinRatio(text) > NON_LATIN_RATIO_THRESHOLD) throw new NonEnglishResumeError();
  if (text.length >= MIN_LENGTH_FOR_WORD_CHECK && englishWordHitCount(text) < MIN_ENGLISH_WORD_HITS) {
    throw new NonEnglishResumeError();
  }
}
