import type { TzBand, ScheduleFlex, EmploymentPref, HiringStructure } from "@/types";

// Curated token -> band. Bands are coarse by design (spec §5): overlap-hour
// arithmetic is deliberately dropped.
// SAFE tokens (3+ letters or region words, case-insensitive) are checked in BOTH
// a stated requirement and a location string. STATED_ONLY tokens are bare 2-letter
// abbreviations that collide with country codes ("PT"=Portugal, "ET"=Ethiopia) —
// trusted only inside an explicit stated TZ requirement, never a location string
// (spec §14.2 trust-killer guard: "Lisbon, PT" must not map to Americas).
const SAFE_TOKENS: [RegExp, TzBand][] = [
  [/\b(PST|PDT|MST|MDT|EST|EDT|US ?hours|US working hours|north america|latam|americas)\b/i, "americas"],
  [/\b(CET|CEST|GMT|BST|UTC|EU ?hours|EU working hours|emea|europe)\b/i, "emea"],
  [/\b(SGT|MYT|AEST|AEDT|JST|APAC ?hours|APAC|asia)\b/i, "apac"],
];
const STATED_ONLY_TOKENS: [RegExp, TzBand][] = [
  [/\b(ET|PT)\b/, "americas"], // case-sensitive uppercase; stated source only
];
// Ambiguous, never guessed (spec §5): CST = US Central vs China Standard;
// IST = India vs Israel vs Ireland.
const AMBIGUOUS = /\b(CST|IST)\b/i;

const SCHEDULE_ORDER: ScheduleFlex[] = ["base-hours", "flex-evenings", "any-hours"];
const BAND_MIN_FLEX: Record<TzBand, ScheduleFlex> = {
  apac: "base-hours",
  emea: "flex-evenings",
  americas: "any-hours",
};

// Pure, NON-logging lookup. The recompute scavenge (Task 5) calls this over every
// hiringCountries entry, so it must stay silent on ordinary country names.
export function probeTzToken(text: string, source: "stated" | "location"): TzBand | null {
  if (AMBIGUOUS.test(text)) return null;
  for (const [re, band] of SAFE_TOKENS) if (re.test(text)) return band;
  if (source === "stated") for (const [re, band] of STATED_ONLY_TOKENS) if (re.test(text)) return band;
  return null;
}

export function resolveTzBand(args: { statedTz?: string | null; location?: string | null }): { band: TzBand; evidence: string } | null {
  // Precedence: JD-stated requirement (authority) -> location-string token.
  const sources: [string, "stated" | "location", string | null | undefined][] = [
    ["JD", "stated", args.statedTz],
    ["location", "location", args.location],
  ];
  for (const [label, source, text] of sources) {
    if (!text) continue;
    if (AMBIGUOUS.test(text)) {
      console.warn(`tzBand: ambiguous timezone token, not mapped: "${text}"`);
      return null;
    }
    const band = probeTzToken(text, source);
    if (band) return { band, evidence: `${label}: ${text}` };
    // A non-empty STATED requirement we couldn't map is a drift signal; an
    // unmapped location string is ordinary (most locations carry no TZ token).
    if (source === "stated") {
      console.warn(`tzBand: unmapped timezone requirement: "${text}"`);
      return null;
    }
  }
  return null; // nothing mapped -> no band
}

export function allowedBandsFor(flex: ScheduleFlex): TzBand[] | null {
  const idx = SCHEDULE_ORDER.indexOf(flex);
  if (idx === SCHEDULE_ORDER.length - 1) return null; // any-hours admits every band
  // A band is allowed iff its minimum required flex is <= the user's flex.
  return (Object.keys(BAND_MIN_FLEX) as TzBand[]).filter(
    (b) => SCHEDULE_ORDER.indexOf(BAND_MIN_FLEX[b]) <= idx,
  );
}

export function allowedStructuresFor(pref: EmploymentPref): HiringStructure[] | null {
  if (pref === "any") return null;
  if (pref === "employee") return ["local-entity", "eor"];
  return ["local-entity"]; // pref === "local-entity"
}
