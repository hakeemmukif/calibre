// Pure UI-facing assembler (task-B6-brief.md "features/feed Job assembly"):
// jobs ⋈ job_scores ⋈ sources -> the frozen §5 Job. NO db/llm imports here —
// everything it needs arrives already loaded on `JobJoinScore`.
import type { JobJoinScore } from "@/server/persistence/repos/jobs";
import { eligibilityTone } from "@/server/score/eligibility";
import type { JdFacts } from "@/server/score/jdFacts";
import { Job, type HiringStructure, type LegitimacyTier, type Tone, type TzBand } from "@/types";

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

// Schedule/structure row pills (spec §7). `Tone` has no `neutral`, so these
// informational pills reuse `warn`/`good` (display decision, reconciliation
// #3) rather than widen the enum. `apac` is suppressed — business-as-usual
// from MY, same reasoning as suppressing "Malaysia" on local rows.
const SCHEDULE_LABEL: Record<Exclude<TzBand, "apac">, string> = { emea: "EU hours", americas: "US hours" };
const STRUCTURE_PILL: Record<HiringStructure, { tone: Tone; label: string }> = {
  contractor: { tone: "warn", label: "Contractor" },
  eor: { tone: "warn", label: "EOR" },
  "local-entity": { tone: "good", label: "Local entity" },
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

  const extraTags: { tone: Tone; label: string }[] = [];
  if (job.tzBand && job.tzBand !== "apac") extraTags.push({ tone: "warn", label: SCHEDULE_LABEL[job.tzBand] });
  if (job.hiringStructure) extraTags.push(STRUCTURE_PILL[job.hiringStructure]);

  // workCalendar (spec §7): stated-only calendar expectation, surfaced as a
  // gap row — no dial hides on it, display only.
  const { workCalendar } = score.jdFacts as JdFacts;
  const gaps = workCalendar ? [...score.gaps, { tone: "warn" as const, k: "Work calendar", v: workCalendar }] : score.gaps;

  return Job.parse({
    id: job.id,
    score: score.score,
    ...(tier === "ghost" ? { ghost: true } : {}),
    role: job.title,
    company: job.company,
    meta: `${job.location} · ${job.salaryRaw ?? "—"}`,
    verdict: score.verdict,
    why: score.why,
    // Legitimacy tag + stated schedule/structure pills (spec §7). Eligibility
    // renders as its own EligibilityTag pill (with hover evidence, spec §8)
    // alongside `tags[]`, not inside it.
    tags: [{ tone, label: TIER_LABEL[tier] }, ...extraTags],
    breakdown: score.breakdown,
    fit: score.fit,
    gaps,
    legitimacy: { tier, tone, summary, confidence },
    eligibility,
    applyUrl,
    source: { id: source.id, name: source.name, kind: source.kind, persona: job.persona },
    persona: job.persona,
    firstSeen: job.firstSeenAt.toISOString(),
    isNew,
  });
}
