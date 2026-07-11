// Lever connector — CONFIRMED endpoint (career-ops/providers/lever.mjs, in
// production use): `api.lever.co/v0/postings/{slug}` → `hostedUrl`. `slug`
// from the source row's `config.slug`.
import type { SourceRow } from "@/server/persistence/repos/sources";
import type { RawPosting, SourceConnector } from "../connector";
import { fetchJson } from "./_http";

interface LeverPosting {
  text?: string;
  hostedUrl?: string;
  categories?: { location?: string };
  descriptionPlain?: string;
  createdAt?: number;
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
          description: typeof p.descriptionPlain === "string" ? p.descriptionPlain : undefined,
          postedAt: typeof p.createdAt === "number" ? new Date(p.createdAt).toISOString() : undefined,
        };
        yield posting;
      }
      ctx.onProgress({ stage: "fetch", current: 1, total: 1, label: `Lever (${slug}) done` });
    },
  };
}
