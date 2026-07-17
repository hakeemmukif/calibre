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

// Unambiguous geography -> band. Extends the location path so real PLACE NAMES
// (not just TZ abbreviations) resolve — the fix for locations like "Kuala
// Lumpur" that carry an obvious timezone but no TZ token. UNAMBIGUOUS-ONLY by
// construction: an omitted place stays null (status quo), so the map is safe to
// grow; the ONLY unsafe entry is a WRONG one, so names with a cross-region
// homonym are deliberately excluded (Georgia country/US-state, Perth AU/UK,
// Dublin IE/US, Athens GR/US, Santiago CL/ES, San Jose CR/US). Bare 2-letter
// codes are NEVER added here — the §14.2 trust-killer (a location "Lisbon, PT"
// must not read PT as Pacific) is preserved because PT is not a place name in
// this map; "Lisbon" now correctly resolves emea from the CITY, not the code.
// Countries carry most of the weight (near-zero homonym risk); cities are
// curated to globally-unique hubs plus the MY market's own towns.
const PLACE_NAMES: Record<TzBand, string[]> = {
  apac: [
    "Malaysia", "Singapore", "Indonesia", "Thailand", "Philippines", "Vietnam",
    "Cambodia", "Laos", "Myanmar", "Brunei", "India", "China", "Japan",
    "South Korea", "Taiwan", "Hong Kong", "Sri Lanka", "Nepal", "Bangladesh",
    "Pakistan", "Mongolia", "Australia", "New Zealand",
    // Malaysia — the local persona's home market: all 13 states + FT + major
    // towns, so "Ipoh, Perak" / "Kuching, Sarawak" resolve off the state token.
    "Kuala Lumpur", "Selangor", "Penang", "Johor", "Kedah", "Kelantan",
    "Melaka", "Malacca", "Negeri Sembilan", "Pahang", "Perak", "Perlis",
    "Sabah", "Sarawak", "Terengganu", "Putrajaya", "Labuan",
    "Petaling Jaya", "Shah Alam", "Cyberjaya", "Johor Bahru", "Subang Jaya",
    "Bayan Lepas", "Ipoh", "Kuching", "Kota Kinabalu", "Kota Bharu",
    "Seremban", "Kuantan", "Klang", "Kajang", "Iskandar Puteri", "Nilai",
    "Jakarta", "Surabaya", "Bandung", "Bangkok", "Manila", "Makati", "Cebu",
    "Hanoi", "Ho Chi Minh", "Bengaluru", "Bangalore", "Mumbai", "New Delhi",
    "Hyderabad", "Chennai", "Kolkata", "Pune", "Gurugram", "Gurgaon", "Noida",
    "Shanghai", "Beijing", "Shenzhen", "Guangzhou", "Hangzhou", "Tokyo",
    "Osaka", "Kyoto", "Seoul", "Taipei", "Sydney", "Melbourne", "Brisbane",
    "Auckland", "Wellington", "Colombo", "Dhaka", "Karachi", "Lahore",
  ],
  emea: [
    "United Kingdom", "England", "Scotland", "Wales", "Ireland", "Germany",
    "France", "Spain", "Portugal", "Italy", "Netherlands", "Belgium", "Poland",
    "Sweden", "Norway", "Denmark", "Finland", "Austria", "Switzerland",
    "Czechia", "Czech Republic", "Romania", "Hungary", "Bulgaria", "Croatia",
    "Serbia", "Ukraine", "Estonia", "Latvia", "Lithuania", "Turkey",
    "United Arab Emirates", "Saudi Arabia", "Israel", "Egypt", "South Africa",
    "Nigeria", "Kenya", "Morocco",
    "London", "Berlin", "Munich", "Hamburg", "Frankfurt", "Cologne", "Madrid",
    "Barcelona", "Lisbon", "Porto", "Milan", "Amsterdam", "Rotterdam",
    "Brussels", "Warsaw", "Krakow", "Stockholm", "Gothenburg", "Oslo",
    "Copenhagen", "Helsinki", "Zurich", "Prague", "Bucharest", "Budapest",
    "Istanbul", "Dubai", "Abu Dhabi", "Tel Aviv", "Cairo", "Cape Town",
    "Johannesburg", "Nairobi", "Lagos", "Belgrade",
  ],
  americas: [
    "United States", "USA", "Canada", "Mexico", "Brazil", "Argentina", "Chile",
    "Colombia", "Peru", "Ecuador", "Uruguay", "Venezuela", "Costa Rica",
    "Panama", "Guatemala",
    "San Francisco", "New York", "Los Angeles", "Chicago", "Seattle", "Austin",
    "Boston", "Denver", "Atlanta", "Miami", "Palo Alto", "Mountain View",
    "Sunnyvale", "Toronto", "Vancouver", "Montreal", "Ottawa", "Sao Paulo",
    "São Paulo", "Rio de Janeiro", "Buenos Aires", "Mexico City", "Bogota",
    "Lima", "Guadalajara", "Monterrey",
  ],
};
// Built once at module load. Internal spaces -> \s+ (tolerate "Ho  Chi  Minh");
// \b anchors both ends so "India" never matches "Indiana" and "China" never
// matches "Chinatown".
const PLACE_TOKENS: [RegExp, TzBand][] = (Object.keys(PLACE_NAMES) as TzBand[]).map((band) => [
  new RegExp(`\\b(?:${PLACE_NAMES[band].map((n) => n.replace(/ /g, "\\s+")).join("|")})\\b`, "i"),
  band,
]);

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
  // Unambiguous place names map under EITHER source — geography is not a
  // stated-vs-location distinction the way bare 2-letter codes are.
  for (const [re, band] of PLACE_TOKENS) if (re.test(text)) return band;
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
