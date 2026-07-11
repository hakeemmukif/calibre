// Greenhouse connector — CONFIRMED endpoint (career-ops/providers/
// greenhouse.mjs, in production use): `boards-api.greenhouse.io/v1/boards/
// {slug}/jobs` → `absolute_url`. `slug` comes from the source row's `config`
// (schema.ts: `sources.config jsonb`; seed.ts's placeholder shape is
// `{slug: "REPLACE_ME"}`).
import type { SourceRow } from "@/server/persistence/repos/sources";
import type { Job } from "@/types";
import type { FormField, RawPosting, SourceConnector } from "../connector";
import { fetchJson } from "./_http";

interface GreenhouseJob {
  id?: number | string;
  title?: string;
  absolute_url?: string;
  location?: { name?: string };
  first_published?: string;
}

// F4 tier 1 (task-B7-brief.md) — the Greenhouse job-boards API's questions
// shape. TODO-verify-live: documented but not confirmed against a live board
// in this task; a genuinely wrong `type` string here only degrades to
// map-fields.ts throwing (never a silently-wrong kind), and extractQuestions
// falls through to tier 2/502 on any failure from this connector.
interface GreenhouseQuestionField {
  name?: string;
  type?: string;
  values?: { label?: string; value?: unknown }[];
}
interface GreenhouseQuestion {
  label?: string;
  required?: boolean;
  fields?: GreenhouseQuestionField[];
}
interface GreenhouseJobDetail {
  questions?: GreenhouseQuestion[];
}

// A Greenhouse posting's absolute_url is `.../{slug}/jobs/{id}` — the id we
// need for the `?questions=true` call, which the frozen `Job` entity doesn't
// carry directly (it has no `externalId` field, only `applyUrl`).
const GREENHOUSE_JOB_ID_RE = /\/jobs\/(\d+)(?:[/?#]|$)/;

function toFormField(q: GreenhouseQuestion): FormField {
  const field = q.fields?.[0];
  const options = field?.values?.map((v) => v.label ?? String(v.value ?? "")).filter((v) => v.length > 0);
  return {
    label: q.label ?? "",
    field_type: field?.type ?? "unknown",
    required: q.required ?? false,
    ...(options && options.length > 0 ? { options } : {}),
  };
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
    // F4 tier 1 (task-B7-brief.md) — highest fidelity, zero scraping. Returns
    // null (never throws) on anything that isn't a clean hit — a missing
    // slug, an unparseable job id, a non-2xx response, or a malformed body —
    // so server/apply-assistant/extract-questions.ts falls through to tier 2
    // rather than failing the whole request over this connector.
    async extractQuestions(job: Job): Promise<FormField[] | null> {
      if (!slug) return null;
      const match = GREENHOUSE_JOB_ID_RE.exec(job.applyUrl);
      if (!match) return null;
      const externalId = match[1];

      try {
        const detail = (await fetchJson(
          `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${externalId}?questions=true`,
        )) as GreenhouseJobDetail;
        if (!Array.isArray(detail?.questions)) return null;
        return detail.questions.map(toFormField);
      } catch {
        return null;
      }
    },
  };
}
