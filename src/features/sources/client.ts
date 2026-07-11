// Sources typed client — the Sources management page (api-contract.md §3
// "GET /api/sources", "PATCH /api/sources/:id"). Never imports server/* or
// lib/llm; mirrors features/feed/client.ts's shape (http wrapper, Source
// .parse on the response).
import { z } from "zod";
import { Source } from "@/types";
import { requestJson } from "@/features/http";

const SourcesResponse = z.object({ items: Source.array() });

export async function listSources(): Promise<Source[]> {
  const result = await requestJson("/api/sources", undefined, SourcesResponse);
  return result.items;
}

export async function setSourceEnabled(id: string, enabled: boolean): Promise<Source> {
  return requestJson(
    `/api/sources/${id}`,
    { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) },
    Source,
  );
}
