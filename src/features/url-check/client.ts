// F2 typed client — starts + polls a pasted-URL check run (api-contract.md
// §5 "POST /api/jobs/check", "GET /api/jobs/check/:id"). Never imports
// server/* or lib/llm.
import { UrlCheck, UrlChecksSnapshot } from "@/types";
import { requestJson } from "@/features/http";
import { refreshCredits } from "@/features/credits/creditsStore";

export interface StartCheckInput {
  url: string;
  text?: string;
}

export async function startCheck(input: StartCheckInput): Promise<UrlCheck> {
  const check = await requestJson(
    "/api/jobs/check",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
    UrlCheck,
  );
  refreshCredits();
  return check;
}

export async function getCheck(id: string): Promise<UrlCheck> {
  return requestJson(`/api/jobs/check/${id}`, undefined, UrlCheck);
}

export async function getChecksByIds(ids: string[]): Promise<UrlChecksSnapshot> {
  return requestJson(`/api/jobs/check?ids=${encodeURIComponent(ids.join(","))}`, undefined, UrlChecksSnapshot);
}

export async function getActiveChecks(): Promise<UrlChecksSnapshot> {
  return requestJson(`/api/jobs/check?active=1`, undefined, UrlChecksSnapshot);
}
