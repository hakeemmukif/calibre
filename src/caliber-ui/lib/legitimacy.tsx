import * as React from "react";
import type { Legitimacy, LegitimacyTier, Tone } from "../../types";
import { Tag } from "../components/Tag";
import { Icon } from "../components/Icon";

// legitimacyTone — the ONE place tier maps to a Tag tone. Never hand-pick a
// tone at a call site; fixtures and components both route through this.
export function legitimacyTone(tier: LegitimacyTier): Tone {
  const map: Record<LegitimacyTier, Tone> = {
    verified: "verified",
    clear: "good",
    suspicious: "warn",
    ghost: "ghost",
    scam: "danger",
  };
  return map[tier];
}

// legitimacyLabel — the display label per tier (§11.8).
export function legitimacyLabel(tier: LegitimacyTier): string {
  const map: Record<LegitimacyTier, string> = {
    verified: "Verified",
    clear: "Clear",
    suspicious: "Suspicious",
    ghost: "Ghost",
    scam: "Likely scam",
  };
  return map[tier];
}

// LegitimacyTag — the legitimacy Tag pill, foregrounded per §11.8:
// verified→badge-check, clear→check (Tag's own defaults), suspicious/scam get
// an explicit alert glyph composed alongside (Tag itself never grows a
// per-tone icon table beyond what the primitive already owns).
export function LegitimacyTag({ legitimacy }: { legitimacy: Legitimacy }) {
  const needsAlert = legitimacy.tier === "suspicious" || legitimacy.tier === "scam";
  return (
    <Tag tone={legitimacy.tone} title={legitimacy.summary}>
      {needsAlert && <Icon name="triangle-alert" size={12} strokeWidth={2.4} />}
      {legitimacyLabel(legitimacy.tier)}
    </Tag>
  );
}
