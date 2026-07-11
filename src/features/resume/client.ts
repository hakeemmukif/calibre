// F1 typed client — the only thing UI/pages call for résumé ingest
// (api-contract.md §3 "POST/GET /api/resume"). Never imports server/* or
// lib/llm; talks to the route over fetch and `.parse`s the response.
import { Resume } from "@/types";
import { requestJson, requestJsonOrNull } from "@/features/http";

export type UploadResumeInput = { file: File } | { text: string };

export async function uploadResume(input: UploadResumeInput): Promise<Resume> {
  if ("file" in input) {
    const formData = new FormData();
    formData.set("file", input.file);
    return requestJson("/api/resume", { method: "POST", body: formData }, Resume);
  }
  return requestJson(
    "/api/resume",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: input.text }) },
    Resume,
  );
}

// 404 (no résumé uploaded yet) resolves to `null` — not an error state.
export async function getResume(): Promise<Resume | null> {
  return requestJsonOrNull("/api/resume", undefined, Resume);
}
