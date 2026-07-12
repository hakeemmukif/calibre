// Pure UI-facing assembler (task-B6-brief.md "features/feed Job assembly"):
// jobs ⋈ job_scores ⋈ sources -> the frozen §5 Job. NO db/llm imports here —
// everything it needs arrives already loaded on `JobJoinScore`.
import type { JobJoinScore } from "@/server/persistence/repos/jobs";
import { eligibilityTone } from "@/server/score/eligibility";
import { Job, type EligibilityTier, type LegitimacyTier } from "@/types";

// Locked interface is `assembleJob(joined: JobJoinScore): Job`; the second,
// OPTIONAL argument is an addition this task needed — `Job.isNew` depends on
// the previous-completed-run cutoff (task-B6-brief.md `/api/jobs` "isNew
// wire->cutoff" rule), a cross-run concern no single {job,score,source} row
// can supply on its own. Omitting it (e.g. no prior completed run exists)
// means every job assembles as `isNew: false` — consistent with the sibling
// `stats.sinceLast` rule ("0 if no prior run").
export interface AssembleJobOptions {
  isNewCutoff?: Date | null;
}

// Presentation-only tier -> tag label. `legitimacyTone` (server/score) is
// still the single source for tier->TONE; this is a features/feed-local
// label string, not a second tone table.
const TIER_LABEL: Record<LegitimacyTier, string> = {
  verified: "Verified",
  clear: "Looks legit",
  suspicious: "Use caution",
  ghost: "Likely stale",
  scam: "Flagged: scam",
};

// Presentation-only eligibility labels (spec §8). Tone comes from
// eligibilityTone (server/score) — never a second tone table.
const ELIGIBILITY_LABEL: Record<EligibilityTier, string> = {
  anywhere: "Work anywhere",
  eligible: "Hires from Malaysia",
  local: "Malaysia",
  abroad: "Relocation",
  unknown: "Eligibility unverified",
};

export function assembleJob(joined: JobJoinScore, opts: AssembleJobOptions = {}): Job {
  const { job, score, source } = joined;

  if (!score.legitimacy) {
    throw new Error(`job_scores row ${score.id} has no legitimacy — cannot assemble a Job (fail loud, no grey default)`);
  }
  const { tier, tone, summary, confidence } = score.legitimacy;

  if (!job.eligibility || !job.eligibilityEvidence) {
    throw new Error(`jobs row ${job.id} has no eligibility — cannot assemble a Job (fail loud, no silent unknown)`);
  }
  const eligibility = {
    tier: job.eligibility,
    tone: eligibilityTone(job.eligibility),
    summary: job.eligibilityEvidence,
  };

  const applyUrl = job.applyUrl ?? job.url; // documented rule — api-contract.md Job.applyUrl
  const isNew = opts.isNewCutoff ? job.firstSeenAt > opts.isNewCutoff : false;

  return Job.parse({
    id: job.id,
    score: score.score,
    ...(tier === "ghost" ? { ghost: true } : {}),
    role: job.title,
    company: job.company,
    meta: `${job.location} · ${job.salaryRaw ?? "—"}`,
    verdict: score.verdict,
    why: score.why,
    // Legitimacy tag + eligibility tag (suppressed on `local` — stamping
    // "Malaysia" on every JobStreet row is noise, spec §8).
    tags: [
      { tone, label: TIER_LABEL[tier] },
      ...(eligibility.tier !== "local" ? [{ tone: eligibility.tone, label: ELIGIBILITY_LABEL[eligibility.tier] }] : []),
    ],
    breakdown: score.breakdown,
    fit: score.fit,
    gaps: score.gaps,
    legitimacy: { tier, tone, summary, confidence },
    eligibility,
    applyUrl,
    source: { id: source.id, name: source.name, kind: source.kind, persona: job.persona },
    persona: job.persona,
    firstSeen: job.firstSeenAt.toISOString(),
    isNew,
  });
}
