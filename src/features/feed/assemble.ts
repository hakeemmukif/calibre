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

// Schedule/structure pills — stated-only, neutral-toned (remote-fit spec §11,
// D2). `apac` is suppressed: business-as-usual from the MY operator base,
// mirrors the eligibility "local" suppression (spec §8). `worldwide` is also
// suppressed (2026-07-21-worldwide-tzband-design.md): a location-agnostic
// posting has no fixed "EU hours"/"US hours"-style schedule to show — there
// is nothing this pill could honestly say.
const SCHEDULE_LABEL: Record<Exclude<TzBand, "apac" | "worldwide">, string> = { emea: "EU hours", americas: "US hours" };
const STRUCTURE_LABEL: Record<HiringStructure, string> = { "local-entity": "Local entity", eor: "EOR", contractor: "Contractor" };

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

  // score.jdFacts is jsonb $type<unknown> (recompute-eligibility.ts:31 precedent).
  const jdFacts = score.jdFacts as JdFacts | undefined;

  // Legitimacy tag stays at tags[0]; schedule/structure pills append after it.
  const tags: { tone: Tone; label: string; title?: string }[] = [{ tone, label: TIER_LABEL[tier] }];
  if (job.tzBand && job.tzBand !== "apac" && job.tzBand !== "worldwide") {
    tags.push({ tone: "neutral", label: SCHEDULE_LABEL[job.tzBand], title: jdFacts?.tzRequirement });
  }
  if (job.hiringStructure) tags.push({ tone: "neutral", label: STRUCTURE_LABEL[job.hiringStructure] });

  const gaps = jdFacts?.workCalendar
    ? [...score.gaps, { tone: "warn" as const, k: "Work calendar", v: jdFacts.workCalendar }]
    : score.gaps;

  return Job.parse({
    id: job.id,
    score: score.score,
    ...(tier === "ghost" ? { ghost: true } : {}),
    role: job.title,
    company: job.company,
    meta: `${job.location} · ${job.salaryRaw ?? "—"}`,
    verdict: score.verdict,
    why: score.why,
    // Legitimacy tag + stated-only schedule/structure pills — eligibility
    // renders as its own EligibilityTag pill (with hover evidence, spec §8)
    // alongside `tags[]`, not inside it.
    tags,
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
