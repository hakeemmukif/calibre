// Task 6: on-demand per-job re-score (`POST /api/jobs/:id/evaluate`) — reuses
// the exact same describe -> score -> assemble pipeline B6's scoreTopCandidates
// runs during a search, just for a single already-persisted job outside a run.
import { getLlm, type LlmClient } from "@/lib/llm/client";
import { assembleJob } from "@/features/feed/assemble";
import { jobsRepo } from "@/server/persistence/repos/jobs";
import { resumesRepo } from "@/server/persistence/repos/resumes";
import { ensureDescription } from "@/server/search/describe";
import { resolveIsNewCutoff } from "@/server/search/jobsFeed";
import { NoActiveResumeError } from "@/server/search/run";
import type { Job } from "@/types";
import { scoreJob } from "./index";

export class UnknownJobError extends Error {
  constructor(id: string) {
    super(`Unknown job: ${id}`);
    this.name = "UnknownJobError";
  }
}

export async function evaluateJob(jobId: string, deps: { llm?: LlmClient } = {}): Promise<Job> {
  const found = await jobsRepo.getRowWithSourceById(jobId);
  if (!found) throw new UnknownJobError(jobId);
  const resume = await resumesRepo.getActive();
  if (!resume) throw new NoActiveResumeError();
  const job = await ensureDescription(found.job, found.source).catch(() => found.job);
  const llm = deps.llm ?? getLlm();
  const score = await scoreJob({ job, resume, llm });
  const isNewCutoff = await resolveIsNewCutoff(found.job.persona);
  return assembleJob({ job, score, source: found.source }, { isNewCutoff });
}
