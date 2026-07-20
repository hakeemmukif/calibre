// F5 typed client — the tracker (api-contract.md §3 "POST/GET
// /api/applications", "PATCH /api/applications/:id"). Never imports
// server/* or lib/llm. `status-map.ts` (foldStatus) already lives in this
// directory from B9 — pure status folding, no fetch of its own.
import { z } from "zod";
import { Application } from "@/types";
import { requestJson } from "@/features/http";
import { track } from "@/features/analytics/client";
import { EVENTS } from "@/features/analytics/events";

export interface MarkAppliedInput {
  jobId: string;
  note?: string;
  tailoredResumeId?: string;
  answersId?: string;
}

export async function markApplied(input: MarkAppliedInput): Promise<Application> {
  const application = await requestJson(
    "/api/applications",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
    Application,
  );
  track(EVENTS.applicationCreated);
  return application;
}

export interface ListApplicationsQuery {
  stage?: 0 | 1 | 2 | 3;
  statusTone?: "good" | "verified" | "neutral";
  cursor?: string;
  limit?: number;
}

const ListApplicationsResponse = z.object({ items: Application.array(), nextCursor: z.string().nullable() });
export type ListApplicationsResponse = z.infer<typeof ListApplicationsResponse>;

export async function listApplications(query: ListApplicationsQuery = {}): Promise<ListApplicationsResponse> {
  const params = new URLSearchParams();
  if (query.stage !== undefined) params.set("stage", String(query.stage));
  if (query.statusTone) params.set("statusTone", query.statusTone);
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const qs = params.toString();
  return requestJson(`/api/applications${qs ? `?${qs}` : ""}`, undefined, ListApplicationsResponse);
}

export type PatchApplicationInput = Partial<{
  stage: 0 | 1 | 2 | 3;
  statusLabel: string;
  statusTone: "good" | "verified" | "neutral";
  note: string;
  tailored: boolean;
  tailoredResumeId: string | null;
  answersId: string | null;
}>;

export async function patchApplication(id: string, patch: PatchApplicationInput): Promise<Application> {
  return requestJson(
    `/api/applications/${id}`,
    { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) },
    Application,
  );
}
