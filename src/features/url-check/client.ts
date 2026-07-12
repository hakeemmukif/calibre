// F2 typed client — starts + polls a pasted-URL check run (api-contract.md
// §5 "POST /api/jobs/check", "GET /api/jobs/check/:id"). Never imports
// server/* or lib/llm.
import { UrlCheck } from "@/types";
import { requestJson } from "@/features/http";

export interface StartCheckInput {
  url: string;
  text?: string;
}

export async function startCheck(input: StartCheckInput): Promise<UrlCheck> {
  return requestJson(
    "/api/jobs/check",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
    UrlCheck,
  );
}

export async function getCheck(id: string): Promise<UrlCheck> {
  return requestJson(`/api/jobs/check/${id}`, undefined, UrlCheck);
}
