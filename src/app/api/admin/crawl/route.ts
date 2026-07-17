// GET /api/admin/crawl — Crawl status panel: the operator's live view of the
// global postings pool filling during a crawl, and its health between crawls.
// requireAdmin()-guarded, mirrors admin/sources/route.ts's degrade
// philosophy: `pool`/`staleness`/`runningCrawl`/`lastRuns`/`perSource` are
// each computed independently — a failing sub-query nulls just that section
// and appends to `errors` rather than 500ing the whole response. A sick
// crawl-status surface must never take the rest of the admin page down.
import { NextResponse } from "next/server";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/errors";
import { requireAdmin } from "@/server/auth/session";
import { crawlRunsRepo } from "@/server/persistence/repos/crawlRuns";
import { sourcesRepo } from "@/server/persistence/repos/sources";
import { isCrawlable } from "@/server/sources/crawl";
import { AdminCrawlStatus } from "@/types";
import type { ErrorEnvelope } from "@/types";

const LAST_RUNS_LIMIT = 7;
const PER_SOURCE_BOTTOM_LIMIT = 10;
const HOUR_MS = 60 * 60 * 1000;

function errorResponse(status: number, code: ErrorEnvelope["error"]["code"], message: string) {
  const body: ErrorEnvelope = { error: { code, message } };
  return NextResponse.json(body, { status });
}

// Each section is computed against its own failure boundary — a thrown error
// here nulls the section and is recorded in `errors`, matching Track O's
// admin/sources health-surface convention (degrade, never 500).
async function section<T>(label: string, errors: string[], fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function GET() {
  try {
    await requireAdmin();
    const errors: string[] = [];

    const pool = await section("pool", errors, () => crawlRunsRepo.getPoolCounts());

    const staleness = await section("staleness", errors, async () => {
      const finishedAt = await crawlRunsRepo.latestSuccessfulFinishedAt();
      return finishedAt === null ? null : (Date.now() - finishedAt.getTime()) / HOUR_MS;
    });

    const runningCrawl = await section("runningCrawl", errors, async () => {
      const running = await crawlRunsRepo.getRunningCrawl(Date.now());
      if (!running) return null;
      return {
        startedAt: running.startedAt.toISOString(),
        postingsSeenThisRun: running.postingsSeenThisRun,
        sourcesWrittenThisRun: running.sourcesWrittenThisRun,
      };
    });

    const lastRuns = await section("lastRuns", errors, async () => {
      // `skipped` (arch note: the single most important derived number here)
      // is computed against the CURRENT sources table, reusing crawl.ts's
      // own isCrawlable predicate — never re-derived — so a 429-stopped host
      // that left a run "completed" still shows the boards it silently missed.
      const enabledCrawlableCount = (await sourcesRepo.listAll()).filter(isCrawlable).length;
      const runs = await crawlRunsRepo.listFinishedRuns(LAST_RUNS_LIMIT);
      return runs.map((run) => {
        const { status } = run;
        if (status === "running") {
          throw new Error(`lastRuns: listFinishedRuns returned a running row (id ${run.id})`);
        }
        if (!run.stats || !run.finishedAt) {
          throw new Error(`lastRuns: finished run "${run.id}" is missing stats/finishedAt`);
        }
        return {
          status,
          startedAt: run.startedAt.toISOString(),
          finishedAt: run.finishedAt.toISOString(),
          durationMs: run.stats.durationMs,
          sourcesOk: run.stats.sourcesOk,
          sourcesFailed: run.stats.sourcesFailed,
          skipped: enabledCrawlableCount - (run.stats.sourcesOk + run.stats.sourcesFailed),
          upserts: run.stats.upserts,
          delists: run.stats.delists,
          perHostBackoffs: run.stats.perHostBackoffs,
          emptyFetches: run.stats.emptyFetches,
        };
      });
    });

    const perSource = await section("perSource", errors, async () => {
      const { items, totalSources } = await crawlRunsRepo.getPerSourceBottom(PER_SOURCE_BOTTOM_LIMIT);
      return {
        items: items.map((row) => ({
          sourceId: row.sourceId,
          name: row.name,
          liveCount: row.liveCount,
          lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
        })),
        totalSources,
      };
    });

    const body = { pool, staleness, runningCrawl, lastRuns, perSource, errors };
    return NextResponse.json(AdminCrawlStatus.parse(body), { status: 200 });
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(401, "UNAUTHORIZED", err.message);
    if (err instanceof ForbiddenError) return errorResponse(403, "FORBIDDEN", err.message);
    throw err;
  }
}
