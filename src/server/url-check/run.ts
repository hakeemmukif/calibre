// url-check orchestrator (spec 2026-07-12-pasted-job-ingestion-design.md §6):
// admission (sync, this file's startUrlCheck) then an async single-job
// ladder (runPipeline) — fetch -> search -> paste-text gate -> persist ->
// ghost-check -> score. Shaped like server/search/run.ts's admission-then-
// fire-and-forget split, but there's no fan-out and no in-memory registry:
// one job, one `url_checks` row, polled via getUrlCheck instead of SSE.
import type { LlmClient } from "@/lib/llm/client";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";
import { jobsRepo } from "@/server/persistence/repos/jobs";
import type { ProfileRow } from "@/server/persistence/repos/profile";
import { resumesRepo, type ResumeRow } from "@/server/persistence/repos/resumes";
import { sourcesRepo } from "@/server/persistence/repos/sources";
import { urlChecksRepo, type UrlCheckRow } from "@/server/persistence/repos/urlChecks";
import { dedupeKeyFor } from "@/server/search/dedupe";
import { NoActiveResumeError } from "@/server/search/run";
import { resolveEligibility } from "@/server/score/eligibility";
import { fetchGhostWebEvidence } from "@/server/score/ghost-web";
import { extractJdFactsForGate, type JdFacts } from "@/server/score/jdFacts";
import type { LivenessResult } from "@/server/score/liveness";
import { scoreJob } from "@/server/score";
import { UrlCheck, type ErrorCode, type UrlCheckRequest, type UrlChecksSnapshot } from "@/types";
import { fetchPageText, MAX_TEXT_CHARS } from "./fetch-page";
import { searchForPosting } from "./search-tier";
import { urlCheckWorker } from "./worker";

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

export async function listActiveChecks(): Promise<UrlChecksSnapshot> {
  const rows = await urlChecksRepo.listActive();
  return { checks: rows.map(assemble), paused: urlCheckWorker.isPaused() };
}

export async function listChecksByIds(ids: string[]): Promise<UrlChecksSnapshot> {
  const rows = await urlChecksRepo.listByIds(ids);
  return { checks: rows.map(assemble), paused: urlCheckWorker.isPaused() };
}

type PostingFacts = Omit<JdFacts, "company"> & { company: string };
type GateOutcome = { kind: "ok"; facts: PostingFacts } | { kind: "not-a-posting" } | { kind: "incomplete" };

// Shared by all three call sites (tier-1 fetched text, tier-2 search
// content, paste-mode text) — spec §6's extract-gate: isJobPosting:false is
// terminal-not-a-posting, null/empty company is incomplete (fail-loud: no
// `?? ""` default lets an empty company through as "ok"). Uses
// JdFactsGateSchema (jdFacts.ts) — isJobPosting required, company
// required-but-nullable — so the model must explicitly emit both rather
// than silently omitting them (see JdFactsGateSchema's comment).
async function runGate(llm: LlmClient, text: string): Promise<{ outcome: GateOutcome; costUsd: number }> {
  const { data, costUsd } = await extractJdFactsForGate(llm, text);
  if (data.isJobPosting === false) return { outcome: { kind: "not-a-posting" }, costUsd };
  const company = data.company;
  if (!company) return { outcome: { kind: "incomplete" }, costUsd };
  return { outcome: { kind: "ok", facts: { ...data, company } }, costUsd };
}

function mapFailure(err: Error): { code: ErrorCode; needsText: boolean } {
  if (err instanceof FetchBlockedError) return { code: "FETCH_BLOCKED", needsText: true };
  if (err instanceof NotAJobPostingError) return { code: "NOT_A_JOB_POSTING", needsText: false };
  if (err instanceof ExtractionIncompleteError) return { code: "EXTRACTION_FAILED", needsText: true };
  if (err instanceof UpstreamLlmError) return { code: "UPSTREAM_LLM_ERROR", needsText: false };
  return { code: "INTERNAL", needsText: false };
}

async function failCheck(checkId: string, err: Error, attempt: number): Promise<void> {
  const { code, needsText } = mapFailure(err);
  await urlChecksRepo.fail(checkId, { code, message: err.message, needsText }, attempt);
}

export async function runPipeline(
  checkId: string,
  req: UrlCheckRequest,
  ctx: {
    llm: LlmClient;
    resumeRow: ResumeRow;
    profile: ProfileRow;
    deps: Required<Omit<UrlCheckDeps, "llm">>;
    attempt: number;
  },
): Promise<void> {
  const { llm, resumeRow, profile, deps, attempt } = ctx;
  try {
    const pasteMode = req.text !== undefined;
    let jdText: string;
    let facts: PostingFacts;
    let pageTitle: string | undefined;
    let tier1Live = false;

    if (pasteMode) {
      // A thrown llm.complete here has no tier-2 to escalate to (pasted text
      // IS the acquisition) — recoverable the same way as an "incomplete"
      // gate outcome: EXTRACTION_FAILED, needsText:true (a fuller paste may
      // fix it), not a generic INTERNAL.
      let gate: Awaited<ReturnType<typeof runGate>>;
      try {
        gate = await runGate(llm, req.text!);
      } catch {
        throw new ExtractionIncompleteError();
      }
      await urlChecksRepo.addCost(checkId, gate.costUsd, attempt);
      if (gate.outcome.kind === "not-a-posting") throw new NotAJobPostingError();
      if (gate.outcome.kind === "incomplete") throw new ExtractionIncompleteError();
      facts = gate.outcome.facts;
      jdText = req.text!;
    } else {
      await urlChecksRepo.updateStage(checkId, "fetching", attempt);
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
          await urlChecksRepo.addCost(checkId, gate.costUsd, attempt);
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
        await urlChecksRepo.updateStage(checkId, "searching", attempt);
        let search: Awaited<ReturnType<typeof searchForPosting>>;
        try {
          search = await deps.searchForPosting(llm, req.url, pageTitle);
        } catch (err) {
          throw new UpstreamLlmError(
            `url-check-search failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        await urlChecksRepo.addCost(checkId, search.costUsd, attempt);
        if (!search.found) throw new FetchBlockedError();

        const gate = await runGate(llm, search.content);
        await urlChecksRepo.addCost(checkId, gate.costUsd, attempt);
        if (gate.outcome.kind === "not-a-posting") throw new NotAJobPostingError();
        if (gate.outcome.kind === "incomplete") throw new ExtractionIncompleteError();
        facts = gate.outcome.facts;
        jdText = search.content;
      }
    }

    await urlChecksRepo.updateStage(checkId, "persisting", attempt);
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
      userId: BOOTSTRAP_ADMIN_ID,
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
      await urlChecksRepo.complete(checkId, { jobId: job.id, alreadyKnown: true }, attempt);
      return;
    }

    await urlChecksRepo.updateStage(checkId, "scoring", attempt);
    // Ghost-web and scoreMatch run concurrently — fetchGhostWebEvidence never
    // throws (its own catch returns a status:"failed" webEvidence), and
    // scoreJob doesn't consume webEvidence until after its LLM call, so
    // there's no ordering dependency (spec §6 latency win).
    const ghostPromise = deps.fetchGhostWebEvidence(llm, job.company, job.title);
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
        webEvidence: ghostPromise.then((g) => g.webEvidence),
      });
    } catch (err) {
      throw new UpstreamLlmError(`scoring failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const ghost = await ghostPromise;
    await urlChecksRepo.addCost(checkId, ghost.costUsd, attempt);
    await urlChecksRepo.addCost(checkId, scoreRow.costUsd, attempt);

    await urlChecksRepo.complete(checkId, { jobId: job.id, alreadyKnown: false }, attempt);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`url-check ${checkId}: pipeline failed:`, error);
    await failCheck(checkId, error, attempt);
  }
}

export async function startUrlCheck(req: UrlCheckRequest): Promise<{ check: UrlCheck; started: boolean }> {
  // Admission order is load-bearing (spec §6): résumé check runs before any
  // URL/text work, so a no-résumé request never reaches an LLM call or a
  // url_checks write — see run.test.ts's zero-LLM-call assertion.
  // TEMP read-scaffold (Task 5 threads the caller's session.userId here):
  // POST /api/jobs/check doesn't call requireUser() yet.
  const resumeRow = await resumesRepo.getActive(BOOTSTRAP_ADMIN_ID);
  if (!resumeRow) throw new NoActiveResumeError();

  if (req.text !== undefined && req.text.length > MAX_TEXT_CHARS) {
    throw new PayloadTooLargeError(req.text.length);
  }

  const dedupeKey = dedupeKeyFor(req.url);
  // TEMP read-scaffold (Task 5 threads the caller's session.userId here):
  // POST /api/jobs/check doesn't call requireUser() yet.
  const existingJob = await jobsRepo.getByDedupeKey(dedupeKey, BOOTSTRAP_ADMIN_ID);

  // A dedupe hit only short-circuits to alreadyKnown when it's actually
  // scored (final review fix wave FIX 1a). An unscored hit is a
  // persisted-but-unscored orphan (a prior run's persist-stage upsert
  // succeeded but scoreJob then threw) — falling through to the normal
  // pipeline below self-heals it: the persist stage's upsert hits the same
  // dedupe key and updates the row, then scoring completes it.
  if (existingJob && (await jobsRepo.hasAnyScore(existingJob.id, BOOTSTRAP_ADMIN_ID))) {
    const row = await urlChecksRepo.insert({
      userId: BOOTSTRAP_ADMIN_ID,
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

  const row = await urlChecksRepo.insert({
    userId: BOOTSTRAP_ADMIN_ID,
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

  // fire-and-forget: enqueue then let the worker own execution
  void urlCheckWorker.kick().catch((err) => console.error("url-check admission: kick failed:", err));
  return { check: assemble(row), started: true };
}
