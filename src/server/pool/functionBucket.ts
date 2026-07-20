// Deterministic hybrid function-mix bucketing (Admin Pool tab spec
// 2026-07-21-admin-pool-tab-design.md §6). Per-posting rule (§1.2):
// postings.functionTag when set (P.4 LLM classifier — ~70/18,518 rows as of
// 2026-07-21), else this keyword fallback on the lowercased title.
// First-match-wins by BUCKET ORDER below, not by substring position in the
// title — e.g. "Head of Engineering" matches `engineering` (bucket 1, via
// "engineer") before it ever reaches `leadership` (bucket 11, via "head
// of"). This order is the operator-reviewed classification (spec §8
// calibration) — do not reorder without re-running that calibration.
export const FUNCTION_BUCKET_IDS = [
  "engineering",
  "data",
  "product",
  "design",
  "sales",
  "marketing",
  "cs_support",
  "people_hr",
  "finance_legal",
  "ops_admin",
  "leadership",
  "other",
] as const;

export type FunctionBucket = (typeof FUNCTION_BUCKET_IDS)[number];

// Quoted single-token patterns in the spec (e.g. `"ml "`, `" ai"`, `"ui "`,
// `"hr "`, `"vp "`) are literal substrings INCLUDING the boundary space —
// kept verbatim here, not turned into word-boundary regex, so behavior
// matches the spec's own wording exactly.
const PATTERNS: Record<Exclude<FunctionBucket, "other">, string[]> = {
  engineering: ["engineer", "developer", "devops", "sre", "architect"],
  data: ["data", "analytics", "machine learning", "ml ", " ai", "scientist"],
  product: ["product manager", "product owner", "program manager", "project manager"],
  design: ["design", "ux", "ui "],
  sales: ["sales", "account executive", "account manager", "business development"],
  marketing: ["marketing", "growth", "content", "seo", "brand"],
  cs_support: ["customer success", "support", "customer experience"],
  people_hr: ["recruit", "people", "talent", "hr "],
  finance_legal: ["finance", "accounting", "legal", "counsel", "compliance"],
  ops_admin: ["operations", "office", "executive assistant", "chief of staff"],
  leadership: ["head of", "director", "vp ", "vice president", "chief"],
};

// First-match-wins over FUNCTION_BUCKET_IDS' order (spec §6) — never
// re-sorted by specificity or substring position.
export function bucketFromTitle(title: string): FunctionBucket {
  const lower = title.toLowerCase();
  for (const bucket of FUNCTION_BUCKET_IDS) {
    if (bucket === "other") continue;
    if (PATTERNS[bucket].some((p) => lower.includes(p))) return bucket;
  }
  return "other";
}
