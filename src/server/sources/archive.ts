// Raw crawl archive writer (2026-07-21-raw-crawl-archive-design.md). Persists
// (a) raw HTTP response bodies teed from _http.ts's fetchJson/postJson/
// fetchText, and (b) every drained RawPosting as JSONL, so future extractor
// work and the legitimacy engine's longitudinal signals can replay a night's
// crawl. Archiving is OFF unless CALIBER_ARCHIVE_DIR is set (§4, no invented
// default path) — startArchiveRun returns an inert no-op writer in that case.
// Every I/O failure is caught, warn-logged with an `[archive]` prefix, and
// counted — NEVER thrown, since the side-channel must never abort the crawl
// (§5). The manifest is still written best-effort even after other failures.
import { AsyncLocalStorage } from "node:async_hooks";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finished } from "node:stream";
import { createGzip, gzipSync } from "node:zlib";

export interface ArchiveResponseEnvelope {
  url: string;
  method: string;
  status: number;
  contentType: string | null;
  body: string;
  fetchedAt: string;
}

export interface ArchivePostingLine {
  runDate: string;
  sourceId: string;
  canonicalKey: string;
  posting: unknown;
}

export interface ArchiveManifestInput {
  runId: string;
  startedAt: string;
  finishedAt: string;
  // sourceId -> whether THIS run's fetch for that source succeeded — set by
  // the crawler; the writer itself only knows pages/postings counts, never
  // fetch success/failure.
  perSourceStatus: Record<string, "ok" | "error">;
}

export interface ArchiveWriter {
  archiveResponse(sourceId: string, envelope: ArchiveResponseEnvelope): void;
  appendPosting(line: ArchivePostingLine): void;
  writeManifest(input: ArchiveManifestInput): void;
  errorCount(): number;
  close(): Promise<void>;
}

// ALS context set by crawler.ts's crawlOneSource around each source's
// discover() drain. _http.ts reads this to decide whether (and where) to tee
// a response — the writer rides along in the context so _http.ts never needs
// a second lookup mechanism (no module-level mutable singleton, matching this
// codebase's closure-factory style — createWriterQueue/createHostLimiter).
export const archiveContext = new AsyncLocalStorage<{
  sourceId: string;
  runDate: string;
  writer: ArchiveWriter;
}>();

function warn(message: string, err: unknown): void {
  console.warn(`[archive] ${message}:`, err);
}

function createDisabledWriter(): ArchiveWriter {
  return {
    archiveResponse() {},
    appendPosting() {},
    writeManifest() {},
    errorCount: () => 0,
    close: () => Promise.resolve(),
  };
}

function createEnabledWriter(root: string, runDate: string): ArchiveWriter {
  const dir = join(root, runDate);
  const responsesDir = join(dir, "responses");
  let errors = 0;
  const pagesBySource = new Map<string, number>();
  const postingsBySource = new Map<string, number>();
  // The postings sink is a single continuous gzip stream held open across
  // the whole run (spec §2b: "gzip append stream, closed at run end") — a
  // real compression window across the night's lines, not one independent
  // gzip member per line (which would balloon size vs. the spec's ~15-40
  // MB/night estimate).
  let gzip: ReturnType<typeof createGzip> | null = null;
  let out: ReturnType<typeof createWriteStream> | null = null;

  function ensurePostingsStream(): void {
    if (gzip) return;
    mkdirSync(dir, { recursive: true });
    out = createWriteStream(join(dir, "postings.jsonl.gz"), { flags: "a" });
    gzip = createGzip();
    out.on("error", (err) => {
      errors += 1;
      warn("postings write stream error", err);
    });
    gzip.on("error", (err) => {
      errors += 1;
      warn("postings gzip stream error", err);
    });
    gzip.pipe(out);
  }

  return {
    archiveResponse(sourceId, envelope) {
      try {
        const seq = (pagesBySource.get(sourceId) ?? 0) + 1;
        pagesBySource.set(sourceId, seq);
        mkdirSync(join(responsesDir, sourceId), { recursive: true });
        writeFileSync(join(responsesDir, sourceId, `${seq}.json.gz`), gzipSync(JSON.stringify(envelope)));
      } catch (err) {
        errors += 1;
        warn(`failed to archive response for source "${sourceId}"`, err);
      }
    },
    appendPosting(line) {
      try {
        ensurePostingsStream();
        gzip?.write(`${JSON.stringify(line)}\n`);
        postingsBySource.set(line.sourceId, (postingsBySource.get(line.sourceId) ?? 0) + 1);
      } catch (err) {
        errors += 1;
        warn("failed to append posting", err);
      }
    },
    writeManifest(input) {
      try {
        mkdirSync(dir, { recursive: true });
        const sourceIds = new Set([
          ...pagesBySource.keys(),
          ...postingsBySource.keys(),
          ...Object.keys(input.perSourceStatus),
        ]);
        const perSource: Record<string, { pages: number; postings: number; status: "ok" | "error" }> = {};
        for (const id of sourceIds) {
          perSource[id] = {
            pages: pagesBySource.get(id) ?? 0,
            postings: postingsBySource.get(id) ?? 0,
            // Defensive only — every source with archived pages/postings was
            // necessarily attempted, so the crawler always supplies a status
            // for it. Unreachable in normal operation.
            status: input.perSourceStatus[id] ?? "error",
          };
        }
        writeFileSync(
          join(dir, "manifest.json"),
          JSON.stringify(
            {
              runId: input.runId,
              startedAt: input.startedAt,
              finishedAt: input.finishedAt,
              perSource,
              archiveErrors: errors,
            },
            null,
            2,
          ),
        );
      } catch (err) {
        errors += 1;
        warn("failed to write manifest", err);
      }
    },
    errorCount: () => errors,
    close(): Promise<void> {
      return new Promise((resolve) => {
        if (!gzip || !out) {
          resolve();
          return;
        }
        // finished() fires on finish OR error OR premature close — including
        // streams that already errored before close() was called. A plain
        // out.on("finish") would hang runCrawl forever on an errored sink,
        // and archive failure must never stall the crawl (§5).
        finished(out, () => resolve());
        gzip.end();
      });
    },
  };
}

export function startArchiveRun(dir: string | undefined, runDate: string): ArchiveWriter {
  if (!dir) return createDisabledWriter();
  return createEnabledWriter(dir, runDate);
}
