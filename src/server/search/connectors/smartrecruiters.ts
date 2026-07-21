// SmartRecruiters connector — CONFIRMED endpoint (career-ops/providers/
// smartrecruiters.mjs, in production use, re-verified live 2026-07-21 against
// `api.smartrecruiters.com/v1/companies/Grab/postings`): paginated
// `limit`/`offset`/`totalFound`, postings carry `id`, `name`, `location`,
// `releasedDate`. `slug` from the source row's `config.slug`.
//
// The donor's primary URL strategy — rewriting a posting's `ref`
// (api.smartrecruiters.com/.../postings/{id}) into
// jobs.smartrecruiters.com/{slug}/postings/{id} — 404s live today. The
// donor's OWN fallback (slug + id + slugified title, e.g.
// `jobs.smartrecruiters.com/Grab/744000138772750-senior-sales-operations-
// analyst`) live-verified 200 and matches the vendor's own `postingUrl` field
// (confirmed on the single-posting detail endpoint, not present on the list
// endpoint) — used here as the only strategy, not a fallback.
import type { SourceRow } from "@/server/persistence/repos/sources";
import type { RawPosting, SourceConnector } from "../connector";
import type { ParsedGeo } from "../geo";
import { fetchJson } from "./_http";

const SR_PAGE_SIZE = 100;
const SR_MAX_PAGES = 50; // safety cap (5000 postings @ 100/page) — career-ops parity

interface SmartRecruitersLocation {
  city?: string;
  region?: string;
  country?: string; // ISO-3166-1 alpha-2, lowercase — live-verified 2026-07-21
  remote?: boolean;
  hybrid?: boolean;
  fullLocation?: string; // vendor-assembled "city, region, country" — region is "" when absent, leaving a double comma
}

interface SmartRecruitersPosting {
  id?: string;
  name?: string;
  releasedDate?: string;
  location?: SmartRecruitersLocation;
  // Live-verified 2026-07-21: `department` is `{}` on every Grab posting;
  // `function.label` (e.g. "Engineering", "Sales Operations") is the field
  // actually carrying the org-unit signal (P.4 tag input, "Department
  // provenance" — the literal field wins, `function` is the honest fallback).
  department?: { label?: string };
  function?: { label?: string };
}

interface SmartRecruitersPostingsResponse {
  content?: SmartRecruitersPosting[];
}

// Structured geo from confirmed payload fields (spec §5 Layer B) — same shape
// as lever's country pass-through + workplaceType mapping.
function smartRecruitersGeo(location: SmartRecruitersLocation | undefined): ParsedGeo | undefined {
  if (!location) return undefined;
  const geo: ParsedGeo = {};
  if (location.remote === true) geo.workMode = "remote";
  else if (location.hybrid === true) geo.workMode = "hybrid";
  if (typeof location.country === "string" && location.country.length === 2) {
    geo.countryCode = location.country.toUpperCase();
  }
  return Object.keys(geo).length > 0 ? geo : undefined;
}

// Vendor `fullLocation` carries full place names ("Pasig City, , Philippines")
// that the tzBand classifier's PLACE_NAMES map can actually match — bare
// alpha-2 codes (the only other location field, `country: "ph"`) cannot,
// deliberately (tzBand.ts §14.2 trust-killer guard). Collapse the empty-
// region artifact instead of reconstructing from parts.
function buildLocationString(location: SmartRecruitersLocation | undefined): string | undefined {
  if (!location) return undefined;
  const full = typeof location.fullLocation === "string" ? location.fullLocation.replace(/,\s*,/g, ",").trim() : "";
  const base = full.length > 0 ? full : [location.city, location.region].filter(Boolean).join(", ");
  const withRemote = location.remote ? [base, "Remote"].filter((s) => s && s.length > 0).join(", ") : base;
  return withRemote.length > 0 ? withRemote : undefined;
}

function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// Live-verified 2026-07-21: routing is by id — an arbitrary (even wrong)
// slug segment still resolves 200, so no per-posting fetch is needed to
// confirm the vendor's exact slugified title.
function publicJobUrl(companySlug: string, id: string, name: string): string {
  const slugified = slugifyName(name);
  return `https://jobs.smartrecruiters.com/${companySlug}/${id}${slugified ? `-${slugified}` : ""}`;
}

export function createSmartRecruitersConnector(source: SourceRow): SourceConnector {
  const slug = (source.config as { slug?: string }).slug;

  return {
    id: source.id,
    kind: source.kind,
    persona: source.persona,
    async *discover(ctx) {
      if (!slug) throw new Error(`smartrecruiters: source "${source.id}" has no config.slug`);

      ctx.onProgress({ stage: "fetch", current: 0, total: SR_MAX_PAGES, label: `Scanning SmartRecruiters (${slug})…` });

      for (let page = 0; page < SR_MAX_PAGES; page += 1) {
        const offset = page * SR_PAGE_SIZE;
        const url = `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=${SR_PAGE_SIZE}&offset=${offset}&status=PUBLIC`;

        let json: unknown;
        try {
          json = await fetchJson(url, { signal: ctx.signal, redirect: "error" });
        } catch (err) {
          // First-page failure is fatal for this connector (surfaced to
          // run.ts → stats.perSource); later pages failing is not — return
          // whatever was already yielded (mirrors jobstreet's degrade-
          // gracefully contract for paginated connectors).
          if (page === 0) throw err;
          break;
        }

        const items = Array.isArray((json as SmartRecruitersPostingsResponse)?.content)
          ? (json as SmartRecruitersPostingsResponse).content!
          : [];
        if (items.length === 0) break;

        for (const p of items) {
          if (!p.id) continue;
          const posting: RawPosting = {
            sourceId: source.id,
            externalId: p.id,
            url: publicJobUrl(slug, p.id, p.name ?? ""),
            title: p.name ?? "",
            company: slug,
            location: buildLocationString(p.location),
            department: p.department?.label || p.function?.label || undefined,
            geo: smartRecruitersGeo(p.location),
            postedAt: p.releasedDate || undefined,
          };
          yield posting;
        }

        ctx.onProgress({
          stage: "fetch",
          current: page + 1,
          total: SR_MAX_PAGES,
          label: `SmartRecruiters (${slug}) page ${page + 1} done`,
        });
        if (items.length < SR_PAGE_SIZE) break;
      }
    },
  };
}
