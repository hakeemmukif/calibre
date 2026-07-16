// F-credits typed client — the balance read (api-contract.md §3
// "GET /api/credits"). Never imports server/* or lib/llm.
import { CreditsResponse } from "@/types";
import { requestJson } from "@/features/http";

export async function getCredits(): Promise<CreditsResponse> {
  return requestJson("/api/credits", undefined, CreditsResponse);
}
