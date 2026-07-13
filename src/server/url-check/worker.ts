// Boot-started singleton that OWNS url-check execution (spec 2026-07-13 §4.3).
// Replaces the fire-and-forget `void runPipeline` in admission: pasting a URL
// enqueues a url_checks row and kicks this worker, which claims rows atomically
// (FOR UPDATE SKIP LOCKED), runs up to SCORE_CONCURRENCY at once via p-limit,
// and survives restarts via lease/attempts recovery. globalThis-guarded so
// Next dev bundle duplication / HMR never spawn two workers or two intervals
// (mirrors src/server/runs/registry.ts).
import pLimit from "p-limit";
import { getLlm, type LlmClient } from "@/lib/llm/client";
import { jobsRepo } from "@/server/persistence/repos/jobs";
import { jobScoresRepo } from "@/server/persistence/repos/jobScores";
import { profileRepo } from "@/server/persistence/repos/profile";
import { resumesRepo } from "@/server/persistence/repos/resumes";
import { urlChecksRepo, type UrlCheckRow } from "@/server/persistence/repos/urlChecks";
import { fetchGhostWebEvidence } from "@/server/score/ghost-web";
import { scoreJob } from "@/server/score";
import { UrlCheckRequest } from "@/types";
import { fetchPageText } from "./fetch-page";
import { runPipeline, type UrlCheckDeps } from "./run";
import { searchForPosting } from "./search-tier";

export const SCORE_CONCURRENCY = 3; // matches SCORE_BATCH_SIZE (search/run.ts:32) — proven concurrent gpt-oss-120b fan-out
const SWEEP_MS = 15_000;
const LEASE_MAX_ATTEMPTS = 2;

function startOfToday(): Date {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return start;
}

function readDailyCapUsd(): number | undefined {
  const raw = process.env.CALIBER_DAILY_LLM_USD;
  if (!raw) return undefined;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new Error(`CALIBER_DAILY_LLM_USD is not a number: "${raw}"`);
  return n;
}

export interface UrlCheckWorkerDeps {
  runPipeline?: typeof runPipeline; // injected in tests
  pipelineDeps?: Required<Omit<UrlCheckDeps, "llm">>; // injected in tests
  llm?: LlmClient;
  dailyCapUsd?: number;
  concurrency?: number;
}

export function createUrlCheckWorker(overrides: UrlCheckWorkerDeps = {}) {
  const concurrency = overrides.concurrency ?? SCORE_CONCURRENCY;
  const limit = pLimit(concurrency);
  const dailyCapUsd = overrides.dailyCapUsd ?? readDailyCapUsd();

  let draining = false;
  let paused = false;
  let interval: ReturnType<typeof setInterval> | null = null;

  async function capReached(): Promise<boolean> {
    if (dailyCapUsd === undefined) return false;
    return (await jobScoresRepo.sumCostUsdSince(startOfToday())) >= dailyCapUsd;
  }

  async function processRow(row: UrlCheckRow): Promise<void> {
    const attempt = row.attempts;
    try {
      // Rehydrate (spec §4.6, the day-one bug): a URL-mode row has raw.text ===
      // null, which UrlCheckRequest.text (min(1).optional()) rejects. Coerce
      // null→undefined then parse so a malformed payload fails THIS row loudly,
      // never crashes the drain loop or silently enters paste-mode.
      let req: UrlCheckRequest;
      try {
        const raw = row.raw as { text: string | null };
        req = UrlCheckRequest.parse({ url: row.url, text: raw?.text ?? undefined });
      } catch (err) {
        await urlChecksRepo.fail(
          row.id,
          { code: "INTERNAL", message: `unrehydratable payload: ${err instanceof Error ? err.message : String(err)}`, needsText: false },
          attempt,
        );
        return;
      }

      // A duplicate that got scored while this row waited finishes as alreadyKnown
      // with zero LLM spend (spec §4.3 claim-time re-check).
      const existingJob = await jobsRepo.getByDedupeKey(row.dedupeKey);
      if (existingJob && (await jobsRepo.hasAnyScore(existingJob.id))) {
        await urlChecksRepo.complete(row.id, { jobId: existingJob.id, alreadyKnown: true }, attempt);
        return;
      }

      const resumeRow = await resumesRepo.getActive();
      if (!resumeRow) {
        await urlChecksRepo.fail(row.id, { code: "INTERNAL", message: "no active résumé at claim time", needsText: false }, attempt);
        return;
      }
      const profile = await profileRepo.get();
      const deps = overrides.pipelineDeps ?? { fetchPageText, searchForPosting, fetchGhostWebEvidence, scoreJob };
      const llm = overrides.llm ?? getLlm();
      // Resolved at call time, not construction time: worker.ts <-> run.ts is a
      // circular import (module doc comment), and capturing `runPipeline` into
      // a top-level const at construction time races the cycle — the binding
      // can still be undefined when createUrlCheckWorker() runs during module
      // load. By the time processRow actually runs (kick()/drainOnce(), always
      // after load finishes), the binding is safely resolved.
      const run = overrides.runPipeline ?? runPipeline;
      await run(row.id, req, { llm, resumeRow, profile, deps, attempt });
    } catch (err) {
      // Last-resort net (used to be the caller's `void runPipeline(...).catch(...)`
      // before the worker cutover): any unexpected throw here — a transient DB
      // error in the calls above, or failCheck itself throwing inside
      // runPipeline's own catch — must not become a floating rejection that
      // crashes the process and drops the re-kick.
      console.error(`url-check worker: processRow crashed for row ${row.id}:`, err);
      await urlChecksRepo
        .fail(row.id, { code: "INTERNAL", message: `worker crashed: ${err instanceof Error ? err.message : String(err)}`, needsText: false }, attempt)
        .catch(() => {});
    }
  }

  // Serialized drain (spec §4.7 must-fix #4): a single in-flight flag guards the
  // loop so two kicks can't both claim into the same free slot. Claim while a
  // p-limit slot is free AND the cost cap is not hit; each finished job re-kicks.
  async function kick(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (limit.activeCount + limit.pendingCount < concurrency) {
        if (await capReached()) { paused = true; break; }
        paused = false;
        const row = await urlChecksRepo.claimNextQueued();
        if (!row) break;
        void limit(() => processRow(row)).then(
          () => void kick(),
          (err) => {
            console.error("url-check worker: drain slot crashed:", err);
            void kick();
          },
        );
      }
    } catch (err) {
      console.error("url-check worker: drain loop error:", err);
    } finally {
      draining = false;
    }
  }

  // Test seam: claim + process exactly one row, AWAITED (kick fire-and-forgets
  // into p-limit, which is not awaitable from a test).
  async function drainOnce(): Promise<boolean> {
    if (await capReached()) { paused = true; return false; }
    paused = false;
    const row = await urlChecksRepo.claimNextQueued();
    if (!row) return false;
    await processRow(row);
    return true;
  }

  function start(): void {
    if (interval) return; // idempotent — never two intervals
    interval = setInterval(() => {
      void urlChecksRepo
        .sweepExpiredLeases(LEASE_MAX_ATTEMPTS)
        .then(() => kick())
        .catch((err) => console.error("url-check worker: sweep failed:", err));
    }, SWEEP_MS);
    interval.unref?.(); // let tests/scripts exit
    void kick();
  }

  function stop(): void {
    if (interval) { clearInterval(interval); interval = null; }
  }

  return { kick, start, stop, drainOnce, isPaused: () => paused };
}

const g = globalThis as unknown as { __caliberUrlCheckWorker?: ReturnType<typeof createUrlCheckWorker> };
g.__caliberUrlCheckWorker ??= createUrlCheckWorker();
export const urlCheckWorker = g.__caliberUrlCheckWorker;
