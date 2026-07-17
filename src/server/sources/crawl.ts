// `npm run crawl:once` — the nightly crawler's entry point (arch §2.1). A plain
// idempotent command: run the whole crawl once, write the pool, record the
// crawl_runs row, exit. Frequency is a cron dial, not code (R3: once/day @
// ~03:00). Also the manual ops/debug entry, optionally scoped to one source.
//
// USAGE
//   npm run crawl:once                 # crawl every enabled, non-dead source
//   npm run crawl:once -- --source gh-stripe   # one source (ops/debug)
//
// VPS CRON (R3 — install via the /box skill; system cron, separate OS process,
// which WAL on the local file: DB is multi-process-safe with, per arch §2.3):
//   0 3 * * *  cd /opt/caliber && /usr/bin/docker compose exec -T app npm run crawl:once >> /var/log/caliber-crawl.log 2>&1
// (adjust the container invocation to the box's compose service name; the
// 48h-staleness surface — P.5 — fail-louds if this stops firing.)
//
// F7: `config.status === 'dead'` rows are skipped here at the entry point (the
// freshness loop owns re-detection); the crawler crawls exactly what it is
// given.
import { fileURLToPath } from "node:url";
import { getDb } from "../persistence/db";
import { sourcesRepo, type SourceRow } from "../persistence/repos/sources";
import { connectorForSource } from "../search/connectors";
import { runCrawl } from "./crawler";

interface CrawlCliArgs {
  sourceId?: string;
}

function parseArgs(argv: string[]): CrawlCliArgs {
  const args: CrawlCliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--source") {
      const value = argv[i + 1];
      if (!value) throw new Error("crawl:once: --source requires a source id");
      args.sourceId = value;
      i += 1;
    } else {
      throw new Error(`crawl:once: unknown argument "${argv[i]}"`);
    }
  }
  return args;
}

function isCrawlable(source: SourceRow): boolean {
  if (!source.enabled) return false;
  if (source.kind === "manual") return false; // no discover
  const status = (source.config as { status?: string } | null)?.status;
  return status !== "dead";
}

export async function runCrawlCli(args: CrawlCliArgs): Promise<void> {
  const all = await sourcesRepo.listAll();
  let sources = all.filter(isCrawlable);
  if (args.sourceId) {
    sources = sources.filter((s) => s.id === args.sourceId);
    if (sources.length === 0) {
      throw new Error(`crawl:once: --source "${args.sourceId}" is not an enabled, crawlable source`);
    }
  }

  console.log(`crawl:once: crawling ${sources.length} source(s)…`);
  const result = await runCrawl({
    db: getDb(),
    sources,
    connectorFor: connectorForSource,
  });

  if (result.status === "skipped") {
    console.log("crawl:once: SKIPPED — another crawl holds the lease (arch §7.3).");
    return;
  }
  console.log(
    `crawl:once: ${result.status} — run ${result.runId}: ` +
      `${result.stats.sourcesOk} ok, ${result.stats.sourcesFailed} failed, ` +
      `${result.sourcesSkipped} skipped, ${result.stats.upserts} upserts, ` +
      `${result.stats.delists} delists, ${result.purged} purged, ` +
      `${result.stats.durationMs}ms. perHost429s=${JSON.stringify(result.stats.perHost429s)}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCrawlCli(parseArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("crawl:once failed:", err);
      process.exit(1);
    });
}
