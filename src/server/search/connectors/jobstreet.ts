// JobStreet connector — system-architecture.md §6 open risk: "MY-board
// connectors are the only truly unproven component ... build one (JobStreet)
// first ... let the persona toggle degrade gracefully if a board breaks."
//
// Shape below mirrors career-ops/providers/jobstreet.mjs (a working provider
// against SEEK's public, no-auth chalice-search v4 API, shared by
// jobstreet.com/seek.com.au/etc). It has NOT been live-probed against this
// Caliber build — TODO: live-verify the endpoint/response shape (host,
// `solrFields`, `data[]` item shape) against a real `id.jobstreet.com`
// request before trusting this connector's output in production; tests here
// exercise a fixture, never live network.
//
// Degrade-gracefully contract: this connector throws on a page-1 fetch
// failure/timeout — same as every other connector — and run.ts's per-
// connector isolation (Promise.allSettled-style, stats.perSource) is what
// makes that non-fatal to the run, not anything special done here.
import type { SourceRow } from "@/server/persistence/repos/sources";
import type { RawPosting, SourceConnector } from "../connector";
import { fetchJson } from "./_http";

const DEFAULT_API = "https://id.jobstreet.com/api/chalice-search/v4/search";
const DEFAULT_SITE_KEY = "ID-Main";
const DEFAULT_PAGE_SIZE = 30;
const DEFAULT_MAX_PAGES = 3;

interface JobstreetConfig {
  api?: string;
  siteKey?: string;
  query?: string;
  location?: string;
  pageSize?: number;
  maxPages?: number;
}

interface JobstreetItem {
  title?: string;
  jobUrl?: string;
  branding?: { companyName?: string };
  companyName?: string;
  advertiser?: { description?: string };
  location?: string;
  listingDate?: string;
}

function deriveBaseUrl(apiUrl: string): string {
  const parsed = new URL(apiUrl);
  return `${parsed.protocol}//${parsed.hostname}`;
}

function resolveJobUrl(rawUrl: string | undefined, baseUrl: string): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch {
    return rawUrl.startsWith("/") ? `${baseUrl}${rawUrl}` : undefined;
  }
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
  url.searchParams.set(
    "solrFields",
    "id,title,location,listingDate,jobUrl,companyName,branding.companyName,advertiser.description,salary",
  );
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
          const url = resolveJobUrl(item.jobUrl, baseUrl);
          if (!title || !url) continue;
          const posting: RawPosting = {
            sourceId: source.id,
            url,
            title,
            company: (item.branding?.companyName || item.companyName || item.advertiser?.description || "").trim(),
            location: (item.location || "").trim() || undefined,
            postedAt: item.listingDate || undefined,
          };
          yield posting;
        }

        ctx.onProgress({ stage: "fetch", current: page, total: maxPages, label: `JobStreet page ${page} done` });
        if (items.length < pageSize) break;
      }
    },
  };
}
