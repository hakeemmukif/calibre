// F4 answer drafting + edit/regenerate persistence (task-B7-brief.md "locked
// interfaces", api-contract.md §3 "POST /api/apply/answers" /
// "PATCH /api/apply/answers/:id"). Grounds every answer in the active résumé
// (+ the job's latest job_scores JdFacts when it's been scored); an answer
// the model can't ground still returns with an EMPTY grounding[] (visible to
// the UI), never dropped or omitted — the frozen ApplicationAnswer schema
// already allows a 0-length grounding array, so no special-casing is needed
// beyond persisting whatever the model returned verbatim.
import { z } from "zod";
import { getLlm, type LlmClient } from "@/lib/llm/client";
import { renderTemplate } from "@/lib/llm/templates";
import { applicationAnswersRepo, type ApplicationAnswersRow } from "@/server/persistence/repos/applicationAnswers";
import { jobScoresRepo } from "@/server/persistence/repos/jobScores";
import { resumesRepo } from "@/server/persistence/repos/resumes";
import { ApplicationAnswer, ApplicationAnswers, type ApplicationQuestion } from "@/types";

export class NoActiveResumeError extends Error {
  constructor(message = "No résumé exists — drafting answers requires an active résumé to ground against.") {
    super(message);
    this.name = "NoActiveResumeError";
  }
}

export class UpstreamLlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamLlmError";
  }
}

export class UnknownAnswersIdError extends Error {
  constructor(id: string) {
    super(`No application_answers row with id "${id}".`);
    this.name = "UnknownAnswersIdError";
  }
}

const DraftAnswersResponse = z.object({ answers: z.array(ApplicationAnswer) });

function toApplicationAnswers(row: ApplicationAnswersRow): ApplicationAnswers {
  return ApplicationAnswers.parse({
    id: row.id,
    jobId: row.jobId,
    resumeId: row.resumeId,
    answers: row.answers,
    model: row.model,
    createdAt: row.createdAt.toISOString(),
  });
}

export async function draftAnswers(
  input: { jobId: string; questions: ApplicationQuestion[] },
  deps: { llm?: LlmClient } = {},
): Promise<ApplicationAnswers> {
  const resumeRow = await resumesRepo.getActive();
  if (!resumeRow) throw new NoActiveResumeError();

  const scoreRow = await jobScoresRepo.getLatestByJobId(input.jobId);
  const jdFactsText = scoreRow?.jdFacts
    ? JSON.stringify(scoreRow.jdFacts)
    : "Not available — this job has not been scored yet.";

  const llm = deps.llm ?? getLlm();
  let result: { data: z.infer<typeof DraftAnswersResponse>; model: string; costUsd: number };
  try {
    result = await llm.complete({
      task: "question-answer",
      messages: renderTemplate("question-answer", {
        resume: JSON.stringify(resumeRow.structured),
        jdFacts: jdFactsText,
        questions: JSON.stringify(input.questions),
      }),
      responseSchema: DraftAnswersResponse,
    });
  } catch (err) {
    throw new UpstreamLlmError(`Answer drafting failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const inserted = await applicationAnswersRepo.insert({
    jobId: input.jobId,
    resumeId: resumeRow.id,
    // KNOWN GAP: neither draftAnswers' locked input ({jobId, questions}) nor
    // the POST /api/apply/answers request body (api-contract.md §3) carries
    // which tier sourced the questions (ats-api|fetched|pasted) — that
    // context lives only in extractQuestions' response and isn't round-
    // tripped back through this call. Recorded as "pasted" (the least-
    // presumptuous tier) rather than guessing a higher-fidelity source.
    formSource: "pasted",
    answers: result.data.answers,
    model: result.model,
    costUsd: result.costUsd,
  });

  return toApplicationAnswers(inserted);
}

export async function patchAnswers(id: string, answers: ApplicationAnswer[]): Promise<ApplicationAnswers> {
  const updated = await applicationAnswersRepo.update(id, answers);
  if (!updated) throw new UnknownAnswersIdError(id);
  return toApplicationAnswers(updated);
}
