// F2/F3 typed client — the scored feed + single-job reads (api-contract.md
// §3 "GET /api/jobs", "GET /api/jobs/:id"). Never imports server/* or
// lib/llm; `features/feed/assemble.ts` (the pure Job assembler used
// server-side) is a separate module from this UI-facing fetch wrapper.
import { z } from "zod";
import { Job, LegitimacyTier, Persona, SummaryStripStats } from "@/types";
import { requestJson } from "@/features/http";

export interface GetJobsQuery {
  persona?: Persona;
  tier?: LegitimacyTier[];
  minScore?: number;
  isNew?: boolean;
  q?: string;
  cursor?: string;
  limit?: number;
}

const JobsFeedResponse = z.object({ items: Job.array(), nextCursor: z.string().nullable(), stats: SummaryStripStats });
export type JobsFeedResponse = z.infer<typeof JobsFeedResponse>;

function buildQuery(query: GetJobsQuery): string {
  const params = new URLSearchParams();
  if (query.persona) params.set("persona", query.persona);
  for (const tier of query.tier ?? []) params.append("tier", tier);
  if (query.minScore !== undefined) params.set("minScore", String(query.minScore));
  if (query.isNew !== undefined) params.set("isNew", String(query.isNew));
  if (query.q !== undefined) params.set("q", query.q);
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export async function getJobs(query: GetJobsQuery = {}): Promise<JobsFeedResponse> {
  return requestJson(`/api/jobs${buildQuery(query)}`, undefined, JobsFeedResponse);
}

export async function getJob(id: string): Promise<Job> {
  return requestJson(`/api/jobs/${id}`, undefined, Job);
}

export async function evaluateJob(id: string): Promise<Job> {
  return requestJson(`/api/jobs/${id}/evaluate`, { method: "POST" }, Job);
}
