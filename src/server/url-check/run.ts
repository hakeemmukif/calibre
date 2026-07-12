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

export async function startUrlCheck(
  req: UrlCheckRequest,
  deps: UrlCheckDeps = {},
): Promise<{ check: UrlCheck; started: boolean }> {
  throw new Error("not implemented");
}
