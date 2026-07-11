// F4 typed client — question extraction + answer drafting/editing
// (api-contract.md §3 "POST /api/apply/questions", "POST /api/apply/answers",
// "PATCH /api/apply/answers/:id"). Never imports server/* or lib/llm.
import { z } from "zod";
import { ApplicationAnswer, ApplicationAnswers, ApplicationQuestion } from "@/types";
import { requestJson } from "@/features/http";

export interface ExtractQuestionsInput {
  jobId?: string;
  url?: string;
  pastedForm?: string;
}

const ExtractQuestionsResponse = z.object({ questions: ApplicationQuestion.array(), sourceUrl: z.string().nullable() });
export type ExtractQuestionsResponse = z.infer<typeof ExtractQuestionsResponse>;

export async function extractQuestions(input: ExtractQuestionsInput): Promise<ExtractQuestionsResponse> {
  return requestJson(
    "/api/apply/questions",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
    ExtractQuestionsResponse,
  );
}

export async function draftAnswers(input: { jobId: string; questions: ApplicationQuestion[] }): Promise<ApplicationAnswers> {
  return requestJson(
    "/api/apply/answers",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
    ApplicationAnswers,
  );
}

export async function patchAnswers(id: string, answers: ApplicationAnswer[]): Promise<ApplicationAnswers> {
  return requestJson(
    `/api/apply/answers/${id}`,
    { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers }) },
    ApplicationAnswers,
  );
}
