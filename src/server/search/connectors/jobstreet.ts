// JobStreet connector — system-architecture.md §6 open risk: "MY-board
// connectors are the only truly unproven component ... build one (JobStreet)
// first ... let the persona toggle degrade gracefully if a board breaks."
//
// SEEK retired the chalice-search v4 API this connector originally targeted
// (career-ops/providers/jobstreet.mjs's endpoint) — 404s on both
// my.jobstreet.com and id.jobstreet.com. Live-verified 2026-07-12 replacement:
// search via the current `jobsearch v5` API (unauthenticated, browser UA),
// full description via the public `/graphql` `jobDetails` query — the SSR job
// page itself is Cloudflare-walled (403) and cannot be scraped directly.
//
// Degrade-gracefully contract: this connector throws on a page-1 fetch
// failure/timeout — same as every other connector — and run.ts's per-
// connector isolation (Promise.allSettled-style, stats.perSource) is what
// makes that non-fatal to the run, not anything special done here.
import type { SourceRow } from "@/server/persistence/repos/sources";
import type { RawPosting, SourceConnector } from "../connector";
import type { ParsedGeo } from "../geo";
import { htmlToText } from "./_html";
import { fetchJson, postJson } from "./_http";

const DEFAULT_API = "https://my.jobstreet.com/api/jobsearch/v5/search";
const DEFAULT_SITE_KEY = "MY-Main";
const DEFAULT_PAGE_SIZE = 30;
const DEFAULT_MAX_PAGES = 3;

const JOB_DETAILS_QUERY = `query jobDetails($id: ID!) { jobDetails(id: $id) { job { id title abstract content } } }`;

interface JobstreetConfig {
  api?: string;
  siteKey?: string;
  query?: string;
  location?: string;
  pageSize?: number;
  maxPages?: number;
}

// locations[].countryCode + workArrangements.displayText live-verified
// 2026-07-12 (docs/architecture/connector-geo-capture.md).
interface JobstreetItem {
  id?: string;
  title?: string;
  companyName?: string;
  advertiser?: { description?: string };
  locations?: { label?: string; countryCode?: string }[];
  workArrangements?: { displayText?: string };
  listingDate?: string;
}

// Structured geo from confirmed payload fields (spec §5 Layer B).
function jobstreetGeo(item: JobstreetItem): ParsedGeo | undefined {
  const geo: ParsedGeo = {};
  const countryCode = item.locations?.find((l) => l.countryCode)?.countryCode;
  if (countryCode) geo.countryCode = countryCode.toUpperCase();
  const wa = item.workArrangements?.displayText?.toLowerCase();
  if (wa === "remote") geo.workMode = "remote";
  else if (wa === "hybrid") geo.workMode = "hybrid";
  else if (wa === "on-site" || wa === "onsite") geo.workMode = "onsite";
  return Object.keys(geo).length > 0 ? geo : undefined;
}

function deriveBaseUrl(apiUrl: string): string {
  const parsed = new URL(apiUrl);
  return `${parsed.protocol}//${parsed.hostname}`;
}

function buildSearchUrl(
  apiUrl: string,
  params: { siteKey: string; keywords: string; location: string; pageSize: number; page: number },
): string {
  const url = new URL(apiUrl);
  if (params.siteKey) url.searchParams.set("siteKey", params.siteKey);
  if (params.keywords) url.searchParams.set("keywords", params.keywords);
  if (params.location) url.searchParams.set("where", params.location);
  url.searchParams.set("pageSize", String(params.pageSize));
  url.searchParams.set("page", String(params.page));
  return url.href;
}

export function createJobstreetConnector(source: SourceRow): SourceConnector {
  const config = source.config as JobstreetConfig;
  const apiUrl = config.api || DEFAULT_API;
  const siteKey = config.siteKey || DEFAULT_SITE_KEY;
  const keywords = config.query || "";
  const location = config.location || "";
  const pageSize = config.pageSize || DEFAULT_PAGE_SIZE;
  const maxPages = config.maxPages || DEFAULT_MAX_PAGES;

  return {
    id: source.id,
    kind: source.kind,
    persona: source.persona,
    async *discover(ctx) {
      const baseUrl = deriveBaseUrl(apiUrl);
      ctx.onProgress({ stage: "fetch", current: 0, total: maxPages, label: "Scanning JobStreet…" });

      for (let page = 1; page <= maxPages; page += 1) {
        const searchUrl = buildSearchUrl(apiUrl, { siteKey, keywords, location, pageSize, page });

        let json: unknown;
        try {
          json = await fetchJson(searchUrl, { signal: ctx.signal, redirect: "error" });
        } catch (err) {
          // First-page failure is fatal for this connector (surfaced to
          // run.ts → stats.perSource); later pages failing is not — return
          // whatever was already yielded.
          if (page === 1) throw err;
          break;
        }

        const items = Array.isArray((json as { data?: JobstreetItem[] })?.data)
          ? (json as { data: JobstreetItem[] }).data
          : [];
        if (items.length === 0) break;

        for (const item of items) {
          const title = (item.title || "").trim();
          // v5 no longer returns a usable jobUrl (always null) — the job page
          // URL is constructed from `id`. Missing id or title is a
          // data-quality filter (matches the prior parser's skip semantics),
          // not a fetch failure.
          if (!item.id || !title) continue;
          const posting: RawPosting = {
            sourceId: source.id,
            url: `${baseUrl}/job/${item.id}`,
            title,
            company: (item.companyName || item.advertiser?.description || "").trim(),
            // ALL location labels, not just the first — multi-location
            // listings were silently truncated (spec §5 Layer A fix).
            location:
              item.locations
                ?.map((l) => l.label?.trim())
                .filter((l): l is string => Boolean(l))
                .join(" / ") || undefined,
            geo: jobstreetGeo(item),
            postedAt: item.listingDate || undefined,
          };
          yield posting;
        }

        ctx.onProgress({ stage: "fetch", current: page, total: maxPages, label: `JobStreet page ${page} done` });
        if (items.length < pageSize) break;
      }
    },
    // jobsearch v5 search results carry no full description (teaser/
    // bulletPoints only); the SSR job page is Cloudflare-walled (403), so the
    // full description comes from the public, unauthenticated `/graphql`
    // `jobDetails` query instead. Called by describe.ts's ensureDescription
    // for the top-N scoring candidates only, never at discover-time fan-out
    // scale.
    async fetchDetail(p) {
      const match = p.url.match(/\/job\/(\d+)/);
      if (!match) throw new Error(`JobStreet detail: could not extract job id from url: ${p.url}`);
      const [, id] = match;
      const graphqlUrl = `${new URL(p.url).origin}/graphql`;

      const json = await postJson(
        graphqlUrl,
        { query: JOB_DETAILS_QUERY, variables: { id } },
        { signal: AbortSignal.timeout(10_000) },
      );
      const content = (json as { data?: { jobDetails?: { job?: { content?: string } } } })?.data?.jobDetails?.job
        ?.content;
      const description = htmlToText(content || "").slice(0, 40_000);
      if (!description) throw new Error(`JobStreet GraphQL detail yielded no text: ${p.url}`);
      return { description };
    },
  };
}
