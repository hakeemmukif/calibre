// Timezone-band resolver + gate helpers (spec 2026-07-14-remote-fit-criteria-design.md §5).
// Pure. Maps a STATED overlap requirement (or a location string's TZ tokens) to a coarse
// band relative to base country MY. No band ⇒ null ⇒ never hidden by the schedule gate.
// Mirrors eligibility.ts's pure-resolver style — curated token table, console.warn on
// drift, fail-loud null.
import type { EmploymentPref, HiringStructure, ScheduleFlex, TzBand } from "@/types";

// Curated token → band. Coarse by design (overlap-hour arithmetic deliberately dropped, §5).
const BAND_TOKENS: { band: TzBand; tokens: string[] }[] = [
  { band: "americas", tokens: ["PST", "PDT", "MST", "EST", "EDT", "ET", "PT", "US HOURS", "NORTH AMERICA", "LATAM"] },
  { band: "emea", tokens: ["CET", "CEST", "GMT", "BST", "UTC", "EU", "EUROPEAN", "EMEA"] },
  { band: "apac", tokens: ["SGT", "MYT", "AEST", "JST", "APAC HOURS", "APAC"] },
];
// "CST" is ambiguous (US Central vs China Standard) — never a band (§5, §9.2).
const AMBIGUOUS = ["CST"];

function bandForString(s: string): { band: TzBand; matched: string } | "ambiguous" | null {
  const up = ` ${s.toUpperCase().replace(/[^A-Z ]/g, " ")} `;
  if (AMBIGUOUS.some((t) => up.includes(` ${t} `))) return "ambiguous";
  for (const { band, tokens } of BAND_TOKENS) {
    const hit = tokens.find((t) => up.includes(` ${t} `));
    if (hit) return { band, matched: hit };
  }
  return null;
}

export function resolveTzBand(args: { tzRequirement?: string | null; location?: string | null }): { band: TzBand; evidence: string } | null {
  const tz = args.tzRequirement?.trim();
  const loc = args.location?.trim();
  for (const [source, value] of [["JD", tz], ["location", loc]] as const) {
    if (!value) continue;
    const r = bandForString(value);
    if (r === "ambiguous") {
      console.warn(`tzBand: ambiguous timezone token in "${value}" (CST) — not banded`);
      return null;
    }
    if (r) return { band: r.band, evidence: `${source}: ${r.matched}` };
    if (source === "JD") {
      // JD stated an overlap requirement we couldn't map — curated-map drift signal (§5).
      console.warn(`tzBand: unmapped stated timezone requirement "${value}"`);
      return null;
    }
  }
  return null;
}

// Band → minimum dial that admits it, relative to base MY (§5): apac needs base-hours,
// emea needs flex-evenings, americas needs any-hours.
const RANK: Record<ScheduleFlex, number> = { "base-hours": 0, "flex-evenings": 1, "any-hours": 2 };
const BAND_MIN: Record<TzBand, ScheduleFlex> = { apac: "base-hours", emea: "flex-evenings", americas: "any-hours" };

// The bands hidden at a given tolerance = those whose minimum dial exceeds it.
export function hiddenBandsFor(flex: ScheduleFlex): TzBand[] {
  return (Object.keys(BAND_MIN) as TzBand[]).filter((b) => RANK[BAND_MIN[b]] > RANK[flex]);
}

// employee admits local-entity + eor; local-entity admits only local-entity (§7).
export function hiddenStructuresFor(pref: EmploymentPref): HiringStructure[] {
  if (pref === "employee") return ["contractor"];
  if (pref === "local-entity") return ["eor", "contractor"];
  return [];
}
