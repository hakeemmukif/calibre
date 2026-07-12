// url-check orchestrator (spec 2026-07-12-pasted-job-ingestion-design.md §6):
// admission (sync, this file's startUrlCheck) then an async single-job
// ladder (runPipeline) — fetch -> search -> paste-text gate -> persist ->
// ghost-check -> score. Shaped like server/search/run.ts's admission-then-
// fire-and-forget split, but there's no fan-out and no in-memory registry:
// one job, one `url_checks` row, polled via getUrlCheck instead of SSE.
import { getLlm, type LlmClient } from "@/lib/llm/client";
import { jobsRepo } from "@/server/persistence/repos/jobs";
import { profileRepo, type ProfileRow } from "@/server/persistence/repos/profile";
import { resumesRepo, type ResumeRow } from "@/server/persistence/repos/resumes";
import { sourcesRepo } from "@/server/persistence/repos/sources";
import { urlChecksRepo, type UrlCheckRow } from "@/server/persistence/repos/urlChecks";
import { dedupeKeyFor } from "@/server/search/dedupe";
import { NoActiveResumeError } from "@/server/search/run";
import { resolveEligibility } from "@/server/score/eligibility";
import { fetchGhostWebEvidence } from "@/server/score/ghost-web";
import { extractJdFacts, type JdFacts } from "@/server/score/jdFacts";
import type { LivenessResult } from "@/server/score/liveness";
import { scoreJob } from "@/server/score";
import { UrlCheck, type ErrorCode, type UrlCheckRequest } from "@/types";
import { fetchPageText, MAX_TEXT_CHARS } from "./fetch-page";
import { searchForPosting } from "./search-tier";

export class PayloadTooLargeError extends Error {
  constructor(length: number) {
    super(
      `Pasted text is ${length.toLocaleString()} chars — the ${MAX_TEXT_CHARS.toLocaleString()}-char cap requires trimming before it can be checked.`,
    );
    this.name = "PayloadTooLargeError";
  }
}

export class FetchBlockedError extends Error {
  constructor(message = "Could not find this posting online — paste the job text to continue.") {
    super(message);
    this.name = "FetchBlockedError";
  }
}

export class NotAJobPostingError extends Error {
  constructor(message = "This page does not look like a job posting.") {
    super(message);
    this.name = "NotAJobPostingError";
  }
}

export class ExtractionIncompleteError extends Error {
  constructor(message = "Could not extract job details from the acquired text — paste the job text to continue.") {
    super(message);
    this.name = "ExtractionIncompleteError";
  }
}

export class ManualSourceMissingError extends Error {
  constructor() {
    super('Source "manual" is missing — run "npm run db:seed" to seed it before checking a URL.');
    this.name = "ManualSourceMissingError";
  }
}

// Internal-only — never thrown out of startUrlCheck (admission has no LLM
// call); wraps an unexpected throw from an async-pipeline LLM call so
// mapFailure can tell it apart from a generic bug (INTERNAL).
class UpstreamLlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamLlmError";
  }
}

export interface UrlCheckDeps {
  llm?: LlmClient;
  fetchPageText?: typeof fetchPageText;
  searchForPosting?: typeof searchForPosting;
  fetchGhostWebEvidence?: typeof fetchGhostWebEvidence;
  scoreJob?: typeof scoreJob;
}

export function assemble(row: UrlCheckRow): UrlCheck {
  return UrlCheck.parse({
    id: row.id,
    url: row.url,
    status: row.status,
    stage: row.stage,
    jobId: row.jobId,
    alreadyKnown: row.alreadyKnown,
    needsText: row.needsText,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  });
}

export async function getUrlCheck(id: string): Promise<UrlCheck | null> {
  const row = await urlChecksRepo.getById(id);
  return row ? assemble(row) : null;
}

type PostingFacts = Omit<JdFacts, "company"> & { company: string };
type GateOutcome = { kind: "ok"; facts: PostingFacts } | { kind: "not-a-posting" } | { kind: "incomplete" };

// Shared by all three call sites (tier-1 fetched text, tier-2 search
// content, paste-mode text) — spec §6's extract-gate: isJobPosting:false is
// terminal-not-a-posting, undefined/no-company is incomplete (fail-loud: no
// `?? ""` default lets an empty company through as "ok").
async function runGate(llm: LlmClient, text: string): Promise<{ outcome: GateOutcome; costUsd: number }> {
  const { data, costUsd } = await extractJdFacts(llm, text);
  if (data.isJobPosting === false) return { outcome: { kind: "not-a-posting" }, costUsd };
  const company = data.company;
  if (data.isJobPosting === undefined || !company) return { outcome: { kind: "incomplete" }, costUsd };
  return { outcome: { kind: "ok", facts: { ...data, company } }, costUsd };
}

function mapFailure(err: Error): { code: ErrorCode; needsText: boolean } {
  if (err instanceof FetchBlockedError) return { code: "FETCH_BLOCKED", needsText: true };
  if (err instanceof NotAJobPostingError) return { code: "NOT_A_JOB_POSTING", needsText: false };
  if (err instanceof ExtractionIncompleteError) return { code: "EXTRACTION_FAILED", needsText: true };
  if (err instanceof UpstreamLlmError) return { code: "UPSTREAM_LLM_ERROR", needsText: false };
  return { code: "INTERNAL", needsText: false };
}

async function failCheck(checkId: string, err: Error): Promise<void> {
  const { code, needsText } = mapFailure(err);
  await urlChecksRepo.fail(checkId, { code, message: err.message, needsText });
}

async function runPipeline(
  checkId: string,
  req: UrlCheckRequest,
  ctx: {
    llm: LlmClient;
    resumeRow: ResumeRow;
    profile: ProfileRow;
    deps: Required<Omit<UrlCheckDeps, "llm">>;
  },
): Promise<void> {
  const { llm, resumeRow, profile, deps } = ctx;
  try {
    const pasteMode = req.text !== undefined;
    let jdText: string;
    let facts: PostingFacts;
    let pageTitle: string | undefined;
    let tier1Live = false;

    if (pasteMode) {
      const gate = await runGate(llm, req.text!);
      await urlChecksRepo.addCost(checkId, gate.costUsd);
      if (gate.outcome.kind === "not-a-posting") throw new NotAJobPostingError();
      if (gate.outcome.kind === "incomplete") throw new ExtractionIncompleteError();
      facts = gate.outcome.facts;
      jdText = req.text!;
    } else {
      await urlChecksRepo.updateStage(checkId, "fetching");
      const fetched = await deps.fetchPageText(req.url);

      let tier1Facts: PostingFacts | undefined;
      let tier1Text: string | undefined;
      if (fetched.ok) {
        pageTitle = fetched.pageTitle;
        // Any thrown llm.complete OR any gate failure escalates to tier 2
        // (spec §6 tier-1: "authwall boilerplate legitimately extracts as
        // garbage; that's a signal to search, not to die") — never fails
        // the check from this branch.
        try {
          const gate = await runGate(llm, fetched.text);
          await urlChecksRepo.addCost(checkId, gate.costUsd);
          if (gate.outcome.kind === "ok") {
            tier1Facts = gate.outcome.facts;
            tier1Text = fetched.text;
          }
        } catch (err) {
          console.error(`url-check ${checkId}: tier-1 extract-gate threw, escalating to tier 2:`, err);
        }
      }

      if (tier1Facts && tier1Text) {
        facts = tier1Facts;
        jdText = tier1Text;
        tier1Live = true;
      } else {
        await urlChecksRepo.updateStage(checkId, "searching");
        let search: Awaited<ReturnType<typeof searchForPosting>>;
        try {
          search = await deps.searchForPosting(llm, req.url, pageTitle);
        } catch (err) {
          throw new UpstreamLlmError(
            `url-check-search failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        await urlChecksRepo.addCost(checkId, search.costUsd);
        if (!search.found) throw new FetchBlockedError();

        const gate = await runGate(llm, search.content);
        await urlChecksRepo.addCost(checkId, gate.costUsd);
        if (gate.outcome.kind === "not-a-posting") throw new NotAJobPostingError();
        if (gate.outcome.kind === "incomplete") throw new ExtractionIncompleteError();
        facts = gate.outcome.facts;
        jdText = search.content;
      }
    }

    await urlChecksRepo.updateStage(checkId, "persisting");
    const manualSource = await sourcesRepo.getById("manual");
    if (!manualSource) throw new ManualSourceMissingError();

    const eligibility = resolveEligibility({
      baseCountry: profile.baseCountry,
      sourceKind: "manual",
      sourceGeo: {}, // Layers A/B structurally absent for kind "manual" (spec §6)
      location: facts.location ?? "",
      jdFacts: facts,
    });

    const job = await jobsRepo.upsertByDedupeKey({
      dedupeKey: dedupeKeyFor(req.url),
      url: req.url,
      applyUrl: req.url,
      sourceId: manualSource.id,
      title: facts.title,
      company: facts.company,
      // NOT NULL column, JD doesn't always state one — the one sanctioned
      // normalization (07-11 §9 precedent), not a fail-loud violation: the
      // absence itself is preserved as "" rather than guessed.
      location: facts.location ?? "",
      description: jdText,
      persona: "pasted",
      eligibility: eligibility.tier,
      eligibilityEvidence: eligibility.evidence,
      aliases: [],
      raw: { jdFacts: facts, acquisition: tier1Live ? "fetch" : pasteMode ? "paste" : "search" },
    });

    // Concurrent scan race (spec §10): between admission's dedupe lookup and
    // this upsert, a scan won the same dedupe key — first-writer-wins, so
    // `job` is the SCANNED row. Complete as alreadyKnown rather than ghost-
    // checking/scoring a job this pipeline no longer owns.
    if (job.sourceId !== "manual") {
      await urlChecksRepo.complete(checkId, { jobId: job.id, alreadyKnown: true });
      return;
    }

    await urlChecksRepo.updateStage(checkId, "ghost-check");
    const ghost = await deps.fetchGhostWebEvidence(llm, job.company, job.title);
    await urlChecksRepo.addCost(checkId, ghost.costUsd);

    await urlChecksRepo.updateStage(checkId, "scoring");
    let scoreRow: Awaited<ReturnType<typeof scoreJob>>;
    try {
      scoreRow = await deps.scoreJob({
        job,
        source: manualSource,
        profile,
        resume: resumeRow,
        llm,
        precomputedJdFacts: facts,
        // never 'expired' — a bot-walled URL must not re-probe into a false
        // ghost (spec §6, 07-11 §8).
        livenessOverride: (tier1Live ? "active" : "uncertain") satisfies LivenessResult,
        webEvidence: ghost.webEvidence,
      });
    } catch (err) {
      throw new UpstreamLlmError(`scoring failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await urlChecksRepo.addCost(checkId, scoreRow.costUsd);

    await urlChecksRepo.complete(checkId, { jobId: job.id, alreadyKnown: false });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`url-check ${checkId}: pipeline failed:`, error);
    await failCheck(checkId, error);
  }
}

export async function startUrlCheck(
  req: UrlCheckRequest,
  deps: UrlCheckDeps = {},
): Promise<{ check: UrlCheck; started: boolean }> {
  // Admission order is load-bearing (spec §6): résumé check runs before any
  // URL/text work, so a no-résumé request never reaches an LLM call or a
  // url_checks write — see run.test.ts's zero-LLM-call assertion.
  const resumeRow = await resumesRepo.getActive();
  if (!resumeRow) throw new NoActiveResumeError();

  if (req.text !== undefined && req.text.length > MAX_TEXT_CHARS) {
    throw new PayloadTooLargeError(req.text.length);
  }

  const dedupeKey = dedupeKeyFor(req.url);
  const existingJob = await jobsRepo.getByDedupeKey(dedupeKey);

  if (existingJob) {
    const row = await urlChecksRepo.insert({
      id: crypto.randomUUID(),
      url: req.url,
      dedupeKey,
      status: "completed",
      stage: null,
      jobId: existingJob.id,
      alreadyKnown: true,
      needsText: false,
      error: null,
      costUsd: 0,
      raw: { text: req.text ?? null },
      finishedAt: new Date(),
    });
    return { check: assemble(row), started: false };
  }

  const profile = await profileRepo.get();
  const row = await urlChecksRepo.insert({
    id: crypto.randomUUID(),
    url: req.url,
    dedupeKey,
    status: "queued",
    stage: null,
    jobId: null,
    alreadyKnown: false,
    needsText: false,
    error: null,
    costUsd: 0,
    raw: { text: req.text ?? null },
  });

  const resolvedDeps: Required<Omit<UrlCheckDeps, "llm">> = {
    fetchPageText: deps.fetchPageText ?? fetchPageText,
    searchForPosting: deps.searchForPosting ?? searchForPosting,
    fetchGhostWebEvidence: deps.fetchGhostWebEvidence ?? fetchGhostWebEvidence,
    scoreJob: deps.scoreJob ?? scoreJob,
  };
  const llm = deps.llm ?? getLlm();

  void runPipeline(row.id, req, { llm, resumeRow, profile, deps: resolvedDeps }).catch((err) => {
    // Last-resort net (search/run.ts's failRun precedent): only reachable if
    // failCheck itself throws inside runPipeline's own catch (e.g. DB down).
    console.error(`url-check ${row.id}: pipeline crashed after failCheck also threw:`, err);
  });

  return { check: assemble(row), started: true };
}
