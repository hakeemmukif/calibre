// Eligibility resolver (spec 2026-07-12-remote-local-eligibility-design.md
// §5) — pure. Precedence: board country stamp -> JD-stated facts ->
// connector-parsed geo -> source prior -> unknown. NO branch defaults to an
// eligible tier; the single sanctioned prior grant is an operator-confirmed
// `scope: "anywhere"` source lifting a bare "Remote" to `anywhere` (§6).
// `eligibilityTone` is the ONE server-side tier->tone table (assembleJob
// consumes it); caliber-ui/lib/eligibility.tsx mirrors it for UI/fixtures,
// same split as legitimacy.
import type { EligibilityTier, Tone } from "@/types";
import { parseLocationGeo, type ParsedGeo, type SourceGeo } from "@/server/search/geo";
import type { JdFacts } from "./jdFacts";

const TIER_TONE: Record<EligibilityTier, Tone> = {
  anywhere: "verified",
  eligible: "good",
  local: "good",
  abroad: "warn",
  unknown: "warn",
};

export function eligibilityTone(tier: EligibilityTier): Tone {
  return TIER_TONE[tier];
}

export interface ResolveEligibilityArgs {
  baseCountry: string; // ISO-3166-1 alpha-2 (profile.baseCountry)
  sourceKind: "ats" | "board";
  sourceGeo: SourceGeo; // parseSourceGeo(source)
  location?: string; // connector location string (jobs.location; "" treated as absent)
  connectorGeo?: ParsedGeo; // structured connector geo when a connector supplies it (RawPosting.geo)
  jdFacts?: Pick<JdFacts, "hiringScope" | "hiringCountries">;
}

// Region membership for the launch base country. "yes" only for regions that
// geographically include MY; unmapped terms are "unknown" — never a guess.
const REGIONS_INCLUDING_MY = new Set(["APAC", "SEA"]);
const REGIONS_EXCLUDING_MY = new Set(["EMEA", "AMERICAS", "ANZ"]);

// A stated hiring term ("Malaysia", "APAC", "United States", "4h overlap
// with PST") -> does it include the base country?
function termIncludesBase(term: string, baseCountry: string): "yes" | "no" | "unknown" {
  const geo = parseLocationGeo(term);
  if (geo.countryCode) return geo.countryCode === baseCountry ? "yes" : "no";
  if (geo.regionHint === "worldwide") return "yes";
  if (geo.regionHint && baseCountry === "MY") {
    if (REGIONS_INCLUDING_MY.has(geo.regionHint)) return "yes";
    if (REGIONS_EXCLUDING_MY.has(geo.regionHint)) return "no";
  }
  return "unknown";
}

export function resolveEligibility(args: ResolveEligibilityArgs): { tier: EligibilityTier; evidence: string } {
  const { baseCountry, sourceGeo, jdFacts } = args;

  // 1. Layer A — board country stamp (structural, exact).
  if (args.sourceKind === "board" && sourceGeo.country) {
    return sourceGeo.country === baseCountry
      ? { tier: "local", evidence: `${sourceGeo.country} board source` }
      : { tier: "abroad", evidence: `${sourceGeo.country} board source` };
  }

  // 2. Layer C — JD-stated hiring scope (authority over strings and priors).
  if (jdFacts?.hiringScope === "anywhere") {
    return { tier: "anywhere", evidence: "JD: hires from anywhere" };
  }
  if (jdFacts?.hiringScope === "restricted") {
    const terms = jdFacts.hiringCountries ?? [];
    if (terms.length === 0) return { tier: "unknown", evidence: "JD: restricted hiring, regions unstated" };
    const verdicts = terms.map((t) => ({ term: t, v: termIncludesBase(t, baseCountry) }));
    if (verdicts.some((x) => x.v === "yes")) {
      return {
        tier: "eligible",
        evidence: `JD: hires in ${verdicts
          .filter((x) => x.v === "yes")
          .map((x) => x.term)
          .join(", ")}`,
      };
    }
    const unmapped = verdicts.filter((x) => x.v === "unknown");
    if (unmapped.length > 0) {
      // Curated-map drift signal (spec §9.6) — log, never guess.
      console.warn(`eligibility: unmapped hiring term(s): ${unmapped.map((x) => x.term).join("; ")}`);
      return { tier: "unknown", evidence: `JD: unmapped hiring restriction "${unmapped[0].term}"` };
    }
    return { tier: "abroad", evidence: `JD: hires only in ${terms.join(", ")}` };
  }

  // 3. Layer B — connector geo MERGED over the parsed string: structured
  // fields (a payload's isRemote/country) override, the string fills gaps —
  // a partial connectorGeo must never erase what the string carries.
  const location = args.location && args.location.trim().length > 0 ? args.location : undefined;
  const geo: ParsedGeo = { ...parseLocationGeo(location), ...args.connectorGeo };

  if (geo.regionHint === "worldwide") return { tier: "anywhere", evidence: `location: ${location ?? "worldwide"}` };

  if (geo.workMode === "remote") {
    if (geo.countryCode) {
      return geo.countryCode === baseCountry
        ? { tier: "eligible", evidence: `remote within ${geo.countryCode}` }
        : { tier: "abroad", evidence: `remote restricted to ${geo.countryCode}` };
    }
    if (geo.regionHint) {
      const v = termIncludesBase(geo.regionHint, baseCountry);
      if (v === "yes") return { tier: "eligible", evidence: `remote within ${geo.regionHint}` };
      if (v === "no") return { tier: "abroad", evidence: `remote restricted to ${geo.regionHint}` };
      console.warn(`eligibility: unmapped region hint "${geo.regionHint}"`);
      return { tier: "unknown", evidence: `unmapped remote region "${geo.regionHint}"` };
    }
    // 4. Bare "Remote" — the prior layer (the ONLY grants a prior may make).
    if (sourceGeo.scope === "anywhere") return { tier: "anywhere", evidence: "employer prior: hires anywhere" };
    if (sourceGeo.scope === "restricted" && sourceGeo.regions) {
      const v = sourceGeo.regions.map((r) => termIncludesBase(r, baseCountry));
      if (v.includes("yes")) {
        return { tier: "eligible", evidence: `employer prior: hires in ${sourceGeo.regions.join(", ")}` };
      }
    }
    return { tier: "unknown", evidence: 'bare "Remote" — employer hiring scope unproven' };
  }

  // Onsite/hybrid (or unstated mode) with a resolvable country.
  if (geo.countryCode) {
    return geo.countryCode === baseCountry
      ? { tier: "local", evidence: `location: ${location}` }
      : { tier: "abroad", evidence: `location: ${location}` };
  }

  // 5. Fail-loud floor.
  if (location) return { tier: "unknown", evidence: `unrecognized location "${location}"` };
  return { tier: "unknown", evidence: "no geography stated" };
}
