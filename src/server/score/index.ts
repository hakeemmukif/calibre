// F2 scoring (system-architecture.md §2 `server/score` row). `scoreJob` is
// the single entry point: liveness probe -> Stage 1 JdFacts -> Stage 2
// match-score (+ escalation, owned HERE, not the LLM client) -> 5-tier
// legitimacy -> persisted `job_scores` row (the verdict cache, upsert on
// (jobId,resumeId,policyVersion)). Stage 3 Deep is CUT for MVP.
import type { LlmClient } from "@/lib/llm/client";
import { escalateModelFor } from "@/lib/llm/models";
import { policyVersion } from "@/lib/llm/templates";
import { jobScoresRepo, type JobScoreRow, type NewJobScore } from "@/server/persistence/repos/jobScores";
import type { JobRow } from "@/server/persistence/repos/jobs";
import type { ResumeRow } from "@/server/persistence/repos/resumes";
import { scoreMatch } from "./evalScores";
import { extractJdFacts } from "./jdFacts";
import { legitimacyTone, resolveLegitimacyTier } from "./legitimacy";
import { probeLivenessDeep } from "./liveness";

export async function scoreJob(args: { job: JobRow; resume: ResumeRow; llm: LlmClient }): Promise<JobScoreRow> {
  const { job, resume, llm } = args;

  const liveness = await probeLivenessDeep(job.applyUrl ?? job.url);

  const jdFactsResult = await extractJdFacts(llm, job.description ?? "");

  const cheap = await scoreMatch(llm, { jdFacts: jdFactsResult.data, resume: resume.structured });

  let final = cheap;
  let escalated = false;
  if (cheap.data.lowConfidence) {
    const escalateModel = escalateModelFor("match-score");
    if (escalateModel) {
      const strong = await scoreMatch(llm, { jdFacts: jdFactsResult.data, resume: resume.structured }, escalateModel);
      final = strong;
      escalated = true;
    }
  }

  const tier = resolveLegitimacyTier({
    donorTier: final.data.legitimacy.tier,
    liveness,
    corroborated: final.data.legitimacy.corroborated,
  });

  const row: NewJobScore = {
    jobId: job.id,
    resumeId: resume.id,
    score: final.data.score,
    verdict: final.data.verdict,
    why: final.data.why,
    legitimacy: {
      tier,
      tone: legitimacyTone(tier),
      summary: final.data.legitimacy.summary,
      confidence: final.data.legitimacy.confidence,
      signals: final.data.legitimacy.signals,
    },
    liveness,
    breakdown: final.data.breakdown,
    reasons: final.data.reasons,
    fit: final.data.fit,
    gaps: final.data.gaps,
    jdFacts: jdFactsResult.data,
    model: final.model,
    escalated,
    costUsd: jdFactsResult.costUsd + cheap.costUsd + (escalated ? final.costUsd : 0),
    policyVersion: policyVersion("match-score"),
  };

  return jobScoresRepo.upsertByJobResumePolicy(row);
}
