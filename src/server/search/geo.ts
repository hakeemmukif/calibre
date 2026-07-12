// Deterministic geo parsing over connector location strings (spec §5 Layer
// B). Curated token tables — a miss returns {} (absent, never fabricated).
// This layer may only DEMOTE downstream (unknown), never grant eligibility;
// grants happen in src/server/score/eligibility.ts under its precedence.

export interface ParsedGeo {
  countryCode?: string; // ISO-3166-1 alpha-2, only when derivable
  workMode?: "remote" | "hybrid" | "onsite";
  regionHint?: string; // normalized region token: APAC | SEA | EMEA | AMERICAS | ANZ | worldwide
}

// Token -> ISO country. MY gets a city/state list (the launch base country);
// other countries: names + a few unambiguous majors. Extend via tests only.
const COUNTRY_TOKENS: Record<string, string> = {
  malaysia: "MY",
  "kuala lumpur": "MY",
  selangor: "MY",
  penang: "MY",
  "johor bahru": "MY",
  cyberjaya: "MY",
  putrajaya: "MY",
  "petaling jaya": "MY",
  "klang valley": "MY",
  singapore: "SG",
  "united states": "US",
  usa: "US",
  "u.s.": "US",
  "san francisco": "US",
  "new york": "US",
  seattle: "US",
  austin: "US",
  "united kingdom": "GB",
  london: "GB",
  germany: "DE",
  berlin: "DE",
  france: "FR",
  paris: "FR",
  netherlands: "NL",
  amsterdam: "NL",
  canada: "CA",
  toronto: "CA",
  australia: "AU",
  sydney: "AU",
  india: "IN",
  bangalore: "IN",
  philippines: "PH",
  manila: "PH",
  indonesia: "ID",
  jakarta: "ID",
  vietnam: "VN",
  thailand: "TH",
  bangkok: "TH",
  japan: "JP",
  tokyo: "JP",
  "hong kong": "HK",
  taiwan: "TW",
  "south korea": "KR",
  brazil: "BR",
  mexico: "MX",
  poland: "PL",
  spain: "ES",
  portugal: "PT",
  ireland: "IE",
  dublin: "IE",
};

// US state abbreviations (postal codes) — matched as standalone tokens.
const US_STATES = new Set(
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(
    " ",
  ),
);

const REGION_TOKENS: Record<string, string> = {
  apac: "APAC",
  "asia pacific": "APAC",
  "asia-pacific": "APAC",
  asia: "APAC",
  sea: "SEA",
  "southeast asia": "SEA",
  "south east asia": "SEA",
  asean: "SEA",
  emea: "EMEA",
  europe: "EMEA",
  eu: "EMEA",
  americas: "AMERICAS",
  "north america": "AMERICAS",
  latam: "AMERICAS",
  anz: "ANZ",
  oceania: "ANZ",
  anywhere: "worldwide",
  worldwide: "worldwide",
  global: "worldwide",
};

// Source-level geo annotation (spec §6), read from the sources row's config
// jsonb. Boards carry `country` (their whole inventory is one country — the
// Layer-A structural fact); ATS rows carry `geo.scope` — the operator-
// confirmed prior for reading a bare "Remote". Missing/invalid annotation on
// a real source is a configuration ERROR (fail loud), same posture as the
// registry's unknown-connector throw.

export interface SourceGeo {
  country?: string;
  scope?: "anywhere" | "restricted";
  regions?: string[];
}

export class SourceGeoConfigError extends Error {
  constructor(sourceId: string, detail: string) {
    super(`source "${sourceId}": ${detail}`);
    this.name = "SourceGeoConfigError";
  }
}

export function parseSourceGeo(source: { id: string; kind: "ats" | "board"; config: unknown }): SourceGeo {
  const config = (source.config ?? {}) as { country?: unknown; geo?: { scope?: unknown; regions?: unknown } };

  if (source.kind === "board") {
    if (typeof config.country !== "string" || config.country.length !== 2) {
      throw new SourceGeoConfigError(source.id, 'board source needs config.country (ISO-3166-1 alpha-2, e.g. "MY")');
    }
    return { country: config.country };
  }

  const scope = config.geo?.scope;
  if (scope !== "anywhere" && scope !== "restricted") {
    throw new SourceGeoConfigError(source.id, 'ats source needs config.geo.scope: "anywhere" | "restricted"');
  }
  const regions = Array.isArray(config.geo?.regions) ? (config.geo.regions as string[]) : undefined;
  return { scope, ...(regions ? { regions } : {}) };
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[–—]/g, "-");
}

export function parseLocationGeo(location: string | undefined): ParsedGeo {
  if (!location || location.trim().length === 0) return {};
  const norm = normalize(location);
  const geo: ParsedGeo = {};

  if (/\bremote\b/.test(norm)) geo.workMode = "remote";
  else if (/\bhybrid\b/.test(norm)) geo.workMode = "hybrid";
  else if (/\bon-?site\b/.test(norm)) geo.workMode = "onsite";

  // Multi-word tokens first (longest match wins), then single words.
  const countryEntries = Object.entries(COUNTRY_TOKENS).sort((a, b) => b[0].length - a[0].length);
  for (const [token, code] of countryEntries) {
    if (norm.includes(token)) {
      geo.countryCode = code;
      break;
    }
  }
  if (!geo.countryCode) {
    // Standalone uppercase tokens: "US"/"UK" country shorthands and US state
    // abbreviations ("Austin, TX"). Token-split, so "us" inside a word never
    // fires; keeps "." so "U.S." never fragments.
    const rawTokens = location.split(/[^A-Za-z.]+/).filter(Boolean);
    if (rawTokens.some((t) => t === "US" || US_STATES.has(t))) geo.countryCode = "US";
    else if (rawTokens.some((t) => t === "UK")) geo.countryCode = "GB";
  }

  const regionEntries = Object.entries(REGION_TOKENS).sort((a, b) => b[0].length - a[0].length);
  for (const [token, hint] of regionEntries) {
    // Word-boundary match so "sea" never fires inside "Research" etc.
    if (new RegExp(`\\b${token.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`).test(norm)) {
      geo.regionHint = hint;
      break;
    }
  }

  return geo;
}
