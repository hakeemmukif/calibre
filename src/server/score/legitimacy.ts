// 5-tier legitimacy (system-architecture.md §1 reconciliation): the model
// (config/templates/match-score.md) now emits the frozen 5-tier
// `LegitimacyTier` directly (Block G); this module is a thin OVERLAY on top
// of that — liveness can force `ghost`, and `verified` is downgraded to
// `clear` unless the model also asserted corroboration. `legitimacyTone` is
// the SINGLE source of tier→tone — every caller (this module's own mapping,
// features/feed/assemble.ts's tag) goes through it, never a second table.
//
// spec 2026-07-12-pasted-job-ingestion-design.md §9: `webEvidence` extends
// the overlay for the pasted path only — scanned jobs never pass it, so
// every branch below that checks `webEvidence` is inert for them (steps
// 3b/4 never trigger; behaviour is byte-identical to before this change).
import type { GhostWebEvidence, LegitimacyTier, Tone, WebEvidence } from "@/types";
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

// §9 step 3b — the ATS/career-site allowlist; host SUFFIX match so a
// subdomain (e.g. `boards.greenhouse.io`) still counts.
export const ATS_SIGHTING_HOSTS = ["greenhouse.io", "lever.co", "ashbyhq.com", "workable.com", "smartrecruiters.com"];

function isAtsSighting(url: string): boolean {
  const host = new URL(url).hostname.toLowerCase();
  return ATS_SIGHTING_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

type Sighting = GhostWebEvidence["sightings"][number];

// §8 — derived deterministically, never asked of the model. Dedupe by
// (source, postedDate): the same citation surfacing twice must not double
// its churn weight. Undated sightings count for board-presence display
// (not this function's concern) but never toward repost churn — an undated
// citation cannot support a "reposted N days ago" claim.
export function deriveRepostStats(sightings: Sighting[]): { count90d: number; oldestDays: number | null } {
  const seen = new Set<string>();
  const distinct: Sighting[] = [];
  for (const sighting of sightings) {
    const key = `${sighting.source}::${sighting.postedDate ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(sighting);
  }

  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();
  // Real sonar postedDate values are sometimes free-text prose ("16 days
  // ago") rather than a real date — `new Date(prose)` is Invalid Date, and
  // one NaN would otherwise poison Math.max(...ageDays) below. Filtered out
  // exactly like an undated sighting (final review fix wave FIX 3): an
  // unparseable date cannot support a churn claim either.
  const ageDays = distinct
    .filter((sighting): sighting is Sighting & { postedDate: string } => sighting.postedDate !== undefined)
    .map((sighting) => Math.floor((now - new Date(sighting.postedDate).getTime()) / DAY_MS))
    .filter((days) => Number.isFinite(days));

  return {
    count90d: ageDays.filter((days) => days <= 90).length,
    oldestDays: ageDays.length > 0 ? Math.max(...ageDays) : null,
  };
}

const SEVERITY: Record<LegitimacyTier, number> = { verified: 0, clear: 1, suspicious: 2, ghost: 3, scam: 4 };
function atLeast(tier: LegitimacyTier, floor: LegitimacyTier): LegitimacyTier {
  return SEVERITY[tier] >= SEVERITY[floor] ? tier : floor;
}

export interface ResolveLegitimacyTierArgs {
  tier: LegitimacyTier; // the model's own Block-G tier assertion
  liveness: LivenessResult;
  // Model-asserted corroboration (e.g. cross-referenced against another
  // signal) — `verified` is reserved for this, never taken at face value
  // from the model's own `tier: "verified"` alone (system-architecture.md
  // §1; config/templates/match-score.md defines when the model may set it).
  corroborated?: boolean;
  // Pasted-path only (spec §6) — sonar-sourced posting-history evidence.
  // Absent for scanned jobs.
  webEvidence?: WebEvidence;
}

// Precedence (spec §9, first match wins):
// 1. model `scam` always wins — web evidence can never upgrade a scam.
// 2. `liveness === 'expired'` forces `ghost`.
// 3. model `verified`:
//    a. no webEvidence (scanned path) — corroborated ? verified : clear
//       (unchanged from before this change).
//    b. webEvidence present (pasted path) — verified additionally requires
//       `status === 'ok'` AND >=1 sighting on the ATS allowlist. Self-
//       certified `corroborated` from attacker-controlled pasted text is
//       not corroboration on its own (prompt-injection backstop).
// 4. repost rules — only when `webEvidence.status === 'ok'`, applied to
//    tiers clear|suspicious|ghost (reached only when step 3 did NOT return,
//    so a corroborated-verified posting is never force-demoted by churn).
// 5. otherwise the model's own clear|suspicious|ghost passes through.
export function resolveLegitimacyTier(args: ResolveLegitimacyTierArgs): LegitimacyTier {
  if (args.tier === "scam") return "scam";
  if (args.liveness === "expired") return "ghost";

  if (args.tier === "verified") {
    if (args.webEvidence === undefined) return args.corroborated ? "verified" : "clear"; // 3a
    const corroboratedByAts =
      args.webEvidence.status === "ok" && args.webEvidence.sightings.some((s) => isAtsSighting(s.url));
    return args.corroborated && corroboratedByAts ? "verified" : "clear"; // 3b
  }

  let resolved: LegitimacyTier = args.tier; // clear | suspicious | ghost
  if (args.webEvidence?.status === "ok") {
    const { count90d, oldestDays } = deriveRepostStats(args.webEvidence.sightings);
    if (count90d >= 3 && oldestDays !== null && oldestDays >= 60) resolved = "ghost";
    else if (count90d >= 3 && oldestDays !== null && oldestDays < 60) resolved = atLeast(resolved, "suspicious");
  }
  return resolved;
}
