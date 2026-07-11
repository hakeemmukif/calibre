// Top-N scoring-path detail backfill — a board connector's search API may
// carry no description (JobStreet's chalice-search v4); this fetches and
// persists it once, right before scoring, so scoreJob never has to
// special-case a missing JD beyond EmptyJobDescriptionError. Called by
// run.ts's scoreTopCandidates loop only (TOP_N_CANDIDATES-bounded), never
// during discover-time fan-out. Task 6 (per-job evaluate endpoint) reuses
// this exact export.
import { jobsRepo, type JobRow } from "@/server/persistence/repos/jobs";
import type { SourceRow } from "@/server/persistence/repos/sources";
import type { RawPosting } from "./connector";
import { connectorForSource } from "./connectors";

const DESCRIPTION_CAP = 40_000;

export async function ensureDescription(job: JobRow, source: SourceRow): Promise<JobRow> {
  if (job.description && job.description.trim().length > 0) return job;
  const connector = connectorForSource(source);
  if (!connector.fetchDetail) return job;

  const posting: RawPosting = { sourceId: source.id, url: job.url, title: job.title, company: job.company };
  const detail = await connector.fetchDetail(posting);
  const description = detail.description.slice(0, DESCRIPTION_CAP);
  if (!description.trim()) return job;

  return jobsRepo.updateDescription(job.id, description);
}
