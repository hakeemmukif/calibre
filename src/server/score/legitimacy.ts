// 5-tier legitimacy (system-architecture.md §1 reconciliation): the model
// (config/templates/match-score.md) now emits the frozen 5-tier
// `LegitimacyTier` directly (Block G); this module is a thin OVERLAY on top
// of that — liveness can force `ghost`, and `verified` is downgraded to
// `clear` unless the model also asserted corroboration. `legitimacyTone` is
// the SINGLE source of tier→tone — every caller (this module's own mapping,
// features/feed/assemble.ts's tag) goes through it, never a second table.
import type { LegitimacyTier, Tone } from "@/types";
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
  tier: LegitimacyTier; // the model's own Block-G tier assertion
  liveness: LivenessResult;
  // Model-asserted corroboration (e.g. cross-referenced against another
  // signal) — `verified` is reserved for this, never taken at face value
  // from the model's own `tier: "verified"` alone (system-architecture.md
  // §1; config/templates/match-score.md defines when the model may set it).
  corroborated?: boolean;
}

// Precedence: an explicit model `scam` verdict always wins; a dead posting is
// `ghost` regardless of what the model thought of the text; `verified`
// requires the model's corroboration signal (else downgraded to `clear`);
// otherwise the model's own tier (`clear`/`suspicious`/`ghost`) passes
// through unchanged.
export function resolveLegitimacyTier(args: ResolveLegitimacyTierArgs): LegitimacyTier {
  if (args.tier === "scam") return "scam";
  if (args.liveness === "expired") return "ghost";
  if (args.tier === "verified") return args.corroborated ? "verified" : "clear";
  return args.tier; // clear | suspicious | ghost
}
