// Greenhouse connector — CONFIRMED endpoint (career-ops/providers/
// greenhouse.mjs, in production use): `boards-api.greenhouse.io/v1/boards/
// {slug}/jobs` → `absolute_url`. `slug` comes from the source row's `config`
// (schema.ts: `sources.config jsonb`; seed.ts's placeholder shape is
// `{slug: "REPLACE_ME"}`).
import type { SourceRow } from "@/server/persistence/repos/sources";
import type { RawPosting, SourceConnector } from "../connector";
import { fetchJson } from "./_http";

interface GreenhouseJob {
  id?: number | string;
  title?: string;
  absolute_url?: string;
  location?: { name?: string };
  first_published?: string;
}

function toEpochIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

export function createGreenhouseConnector(source: SourceRow): SourceConnector {
  const slug = (source.config as { slug?: string }).slug;

  return {
    id: source.id,
    kind: source.kind,
    persona: source.persona,
    async *discover(ctx) {
      if (!slug) throw new Error(`greenhouse: source "${source.id}" has no config.slug`);

      ctx.onProgress({ stage: "fetch", current: 0, total: 1, label: `Scanning Greenhouse (${slug})…` });
      const json = (await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, {
        signal: ctx.signal,
        redirect: "error",
      })) as { jobs?: GreenhouseJob[] };

      const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
      for (const j of jobs) {
        if (!j.absolute_url) continue;
        const posting: RawPosting = {
          sourceId: source.id,
          externalId: j.id != null ? String(j.id) : undefined,
          url: j.absolute_url,
          title: j.title ?? "",
          company: slug,
          location: j.location?.name || undefined,
          postedAt: toEpochIso(j.first_published),
        };
        yield posting;
      }
      ctx.onProgress({ stage: "fetch", current: 1, total: 1, label: `Greenhouse (${slug}) done` });
    },
  };
}
