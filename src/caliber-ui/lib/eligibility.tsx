import * as React from "react";
import type { Eligibility, EligibilityTier, Tone } from "../../types";
import { Tag } from "../components/Tag";

// eligibilityTone — the UI-side tier->tone table (mirrors
// server/score/eligibility.ts, same split as legitimacy's two tables).
export function eligibilityTone(tier: EligibilityTier): Tone {
  const map: Record<EligibilityTier, Tone> = {
    anywhere: "verified",
    eligible: "good",
    local: "good",
    abroad: "warn",
    unknown: "warn",
  };
  return map[tier];
}

// eligibilityLabel — display label per tier (spec §8).
export function eligibilityLabel(tier: EligibilityTier): string {
  const map: Record<EligibilityTier, string> = {
    anywhere: "Work anywhere",
    eligible: "Hires from Malaysia",
    local: "Malaysia",
    abroad: "Relocation",
    unknown: "Eligibility unverified",
  };
  return map[tier];
}

// EligibilityTag — the eligibility pill beside the legitimacy pill.
// Suppressed by CALLERS when tier === "local" (stamping "Malaysia" on every
// JobStreet row is noise) — the component itself stays unconditional.
export function EligibilityTag({ eligibility }: { eligibility: Eligibility }) {
  return (
    <Tag tone={eligibility.tone} title={eligibility.summary}>
      {eligibilityLabel(eligibility.tier)}
    </Tag>
  );
}
