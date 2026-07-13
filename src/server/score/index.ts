// F2 scoring (system-architecture.md §2 `server/score` row). `scoreJob` is
// the single entry point: liveness probe -> Stage 1 JdFacts -> Stage 2
// match-score (+ escalation, owned HERE, not the LLM client) -> 5-tier
// legitimacy -> persisted `job_scores` row (the verdict cache, upsert on
// (jobId,resumeId,policyVersion)). Stage 3 Deep is CUT for MVP.
import type { LlmClient } from "@/lib/llm/client";
import { escalateModelFor } from "@/lib/llm/models";
import { policyVersion } from "@/lib/llm/templates";
import { jobScoresRepo, type JobScoreRow, type NewJobScore } from "@/server/persistence/repos/jobScores";
import { jobsRepo, type JobRow } from "@/server/persistence/repos/jobs";
import type { ProfileRow } from "@/server/persistence/repos/profile";
import type { ResumeRow } from "@/server/persistence/repos/resumes";
import type { SourceRow } from "@/server/persistence/repos/sources";
import { parseSourceGeo } from "@/server/search/geo";
import type { WebEvidence } from "@/types";
import { resolveEligibility } from "./eligibility";
import { scoreMatch } from "./evalScores";
import { extractJdFacts, type JdFacts } from "./jdFacts";
import { legitimacyTone, resolveLegitimacyTier } from "./legitimacy";
import { probeLivenessDeep, type LivenessResult } from "./liveness";
import { resolveTzBand } from "./tzBand";

// Thrown when a job has no description to extract facts from — the caller
// (server/search/run.ts) is expected to SKIP scoring and record the job as
// unscored, never fabricate `jdFacts` from an empty string (fail-loud: no
// `?? ""` LLM call).
export class EmptyJobDescriptionError extends Error {
  constructor(jobId: string) {
    super(`job ${jobId} has no description — skipping scoring rather than extracting jdFacts from an empty JD.`);
    this.name = "EmptyJobDescriptionError";
  }
}

export async function scoreJob(args: {
  job: JobRow;
  source: SourceRow;
  profile: ProfileRow;
  resume: ResumeRow;
  llm: LlmClient;
  // Pasted-job pipeline only (spec 2026-07-12-pasted-job-ingestion-design.md
  // §6): the url-check ladder already ran extractJdFacts/fetchPageText —
  // re-running them here would double-spend and, worse, re-probe a
  // bot-walled URL into a false "expired" liveness read.
  precomputedJdFacts?: JdFacts;
  livenessOverride?: LivenessResult;
  webEvidence?: WebEvidence | Promise<WebEvidence>;
}): Promise<JobScoreRow> {
  const { job, source, profile, resume, llm } = args;

  if (!job.description) throw new EmptyJobDescriptionError(job.id);

  const liveness = args.livenessOverride ?? (await probeLivenessDeep(job.applyUrl ?? job.url));

  const jdFactsResult = args.precomputedJdFacts
    ? { data: args.precomputedJdFacts, model: "precomputed", costUsd: 0 }
    : await extractJdFacts(llm, job.description);

  // Layer C (spec §5): re-resolve with JD-stated facts — the authoritative
  // eligibility write. POST /api/jobs/:id/evaluate inherits this for free.
  const eligibility = resolveEligibility({
    baseCountry: profile.baseCountry,
    sourceKind: source.kind,
    sourceGeo: parseSourceGeo(source),
    location: job.location || undefined,
    jdFacts: jdFactsResult.data,
  });
  await jobsRepo.updateEligibility(job.id, eligibility.tier, eligibility.evidence);

  // Authoritative remote-fit write (spec §5): tz_band re-resolved from the
  // JD-stated requirement (else location), hiring_structure from the stated
  // enum — overwrites the ingest-time band-only stamp.
  const tz = resolveTzBand({ statedTz: jdFactsResult.data.tzRequirement, location: job.location || undefined });
  await jobsRepo.updateRemoteFit(job.id, tz?.band ?? null, jdFactsResult.data.hiringStructure ?? null);

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

  const webEvidence = await args.webEvidence;

  const tier = resolveLegitimacyTier({
    tier: final.data.legitimacy.tier,
    liveness,
    corroborated: final.data.legitimacy.corroborated,
    webEvidence,
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
      webEvidence,
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
