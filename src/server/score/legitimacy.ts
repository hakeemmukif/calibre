// 5-tier legitimacy (system-architecture.md §1 reconciliation): combines the
// model's Block-G donor-tier output with the independently-probed liveness
// signal into the frozen 5-tier `LegitimacyTier`. `legitimacyTone` is the
// SINGLE source of tier→tone — every caller (this module's own mapping,
// features/feed/assemble.ts's tag) goes through it, never a second table.
import type { LegitimacyTier, Tone } from "@/types";
import type { DonorLegitimacyTier } from "./evalScores";
import type { LivenessResult } from "./liveness";

const TIER_TONE: Record<LegitimacyTier, Tone> = {
  verified: "verified",
  clear: "good",
  suspicious: "warn",
  ghost: "ghost",
  scam: "danger",
};

export function legitimacyTone(tier: LegitimacyTier): Tone {
  return TIER_TONE[tier];
}

export interface ResolveLegitimacyTierArgs {
  donorTier: DonorLegitimacyTier;
  liveness: LivenessResult;
  // Model-asserted corroboration (e.g. cross-referenced against another
  // signal) — `verified` is reserved for this, never emitted from
  // "High Confidence" alone (system-architecture.md §1).
  corroborated?: boolean;
}

// Precedence: an explicit `Scam` verdict always wins; a dead posting is
// `ghost` regardless of what the model thought of the text; otherwise the
// donor 3-tier collapses per the reconciliation table, with `verified` only
// when the model also signalled corroboration.
export function resolveLegitimacyTier(args: ResolveLegitimacyTierArgs): LegitimacyTier {
  if (args.donorTier === "Scam") return "scam";
  if (args.liveness === "expired") return "ghost";
  if (args.donorTier === "High Confidence") return args.corroborated ? "verified" : "clear";
  return "suspicious"; // Caution | Suspicious
}
