// Ashby connector — CONFIRMED endpoint (career-ops/providers/ashby.mjs, in
// production use): `api.ashbyhq.com/posting-api/job-board/{slug}
// ?includeCompensation=true` → `jobUrl`. `slug` from the source row's
// `config.slug`. Donor gives this endpoint a longer timeout + backoff retry
// (observed ~10s+ server-side latency floor + rate-limiting on repeated
// unauthenticated hits); ported here as a fixed retry budget.
import type { SourceRow } from "@/server/persistence/repos/sources";
import type { RawPosting, SourceConnector } from "../connector";
import { htmlToText } from "./_html";
import { fetchJson } from "./_http";

const ASHBY_TIMEOUT_MS = 30_000;
const ASHBY_RETRIES = 2;

interface AshbyJob {
  title?: string;
  jobUrl?: string;
  location?: string;
  publishedAt?: string;
  descriptionHtml?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createAshbyConnector(source: SourceRow): SourceConnector {
  const slug = (source.config as { slug?: string }).slug;

  return {
    id: source.id,
    kind: source.kind,
    persona: source.persona,
    async *discover(ctx) {
      if (!slug) throw new Error(`ashby: source "${source.id}" has no config.slug`);

      ctx.onProgress({ stage: "fetch", current: 0, total: 1, label: `Scanning Ashby (${slug})…` });
      const url = `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;

      let json: unknown;
      let lastErr: unknown;
      for (let attempt = 0; attempt <= ASHBY_RETRIES; attempt += 1) {
        if (attempt > 0) {
          const backoffMs = 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
          await sleep(backoffMs);
        }
        try {
          json = await fetchJson(url, { timeoutMs: ASHBY_TIMEOUT_MS, signal: ctx.signal });
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (lastErr) throw lastErr;

      const jobs = Array.isArray((json as { jobs?: AshbyJob[] })?.jobs) ? (json as { jobs: AshbyJob[] }).jobs : [];
      for (const j of jobs) {
        if (!j.jobUrl) continue;
        const posting: RawPosting = {
          sourceId: source.id,
          url: j.jobUrl,
          title: j.title ?? "",
          company: slug,
          location: j.location || undefined,
          description:
            typeof j.descriptionHtml === "string" && j.descriptionHtml.trim().length > 0
              ? htmlToText(j.descriptionHtml).slice(0, 40_000)
              : undefined,
          postedAt: j.publishedAt || undefined,
        };
        yield posting;
      }
      ctx.onProgress({ stage: "fetch", current: 1, total: 1, label: `Ashby (${slug}) done` });
    },
  };
}
