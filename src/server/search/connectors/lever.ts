// Lever connector — CONFIRMED endpoint (career-ops/providers/lever.mjs, in
// production use): `api.lever.co/v0/postings/{slug}` → `hostedUrl`. `slug`
// from the source row's `config.slug`.
import type { SourceRow } from "@/server/persistence/repos/sources";
import type { RawPosting, SourceConnector } from "../connector";
import type { ParsedGeo } from "../geo";
import { fetchJson } from "./_http";

// country (ISO-2) + workplaceType live-verified 2026-07-12
// (docs/architecture/connector-geo-capture.md) — only confirmed fields read.
interface LeverPosting {
  text?: string;
  hostedUrl?: string;
  categories?: { location?: string };
  country?: string;
  workplaceType?: string;
  descriptionPlain?: string;
  createdAt?: number;
}

// Structured geo from confirmed payload fields (spec §5 Layer B).
function leverGeo(p: LeverPosting): ParsedGeo | undefined {
  const geo: ParsedGeo = {};
  if (p.workplaceType === "remote") geo.workMode = "remote";
  else if (p.workplaceType === "hybrid") geo.workMode = "hybrid";
  else if (p.workplaceType === "onsite" || p.workplaceType === "on-site") geo.workMode = "onsite";
  if (typeof p.country === "string" && p.country.length === 2) geo.countryCode = p.country.toUpperCase();
  return Object.keys(geo).length > 0 ? geo : undefined;
}

export function createLeverConnector(source: SourceRow): SourceConnector {
  const slug = (source.config as { slug?: string }).slug;

  return {
    id: source.id,
    kind: source.kind,
    persona: source.persona,
    async *discover(ctx) {
      if (!slug) throw new Error(`lever: source "${source.id}" has no config.slug`);

      ctx.onProgress({ stage: "fetch", current: 0, total: 1, label: `Scanning Lever (${slug})…` });
      const json = await fetchJson(`https://api.lever.co/v0/postings/${slug}`, { signal: ctx.signal });
      const postings = Array.isArray(json) ? (json as LeverPosting[]) : [];

      for (const p of postings) {
        if (!p.hostedUrl) continue;
        const posting: RawPosting = {
          sourceId: source.id,
          url: p.hostedUrl,
          title: p.text ?? "",
          company: slug,
          location: p.categories?.location || undefined,
          geo: leverGeo(p),
          description: typeof p.descriptionPlain === "string" ? p.descriptionPlain : undefined,
          postedAt: typeof p.createdAt === "number" ? new Date(p.createdAt).toISOString() : undefined,
        };
        yield posting;
      }
      ctx.onProgress({ stage: "fetch", current: 1, total: 1, label: `Lever (${slug}) done` });
    },
  };
}
