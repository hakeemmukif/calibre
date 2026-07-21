# Raw Crawl Archive — design

**Status:** approved by operator 2026-07-21; pre-implementation.
**Decisions locked:** capture = raw response bodies **and** per-posting JSONL (operator option C, "keep track of our own jobs as a data asset"); retention = keep everything on box + nightly encrypted R2 copy (option A).

## 1. Purpose

The nightly crawl fetches ~819 sources (all five live connectors hit JSON APIs) and discards the raw response body the moment `res.json()` returns (`src/server/search/connectors/_http.ts`). `postings.raw` keeps only the *latest* parsed `RawPosting` per posting — overwritten on every upsert, deleted at purge (R4). Two things are therefore unrecoverable today: full-fidelity response data (fields the mappers drop, HTTP status/headers), and history (how a posting changed night over night, when it disappeared).

The archive persists both, so that (a) future extractor improvements can reprocess past crawls, and (b) the legitimacy engine gains a longitudinal corpus — posting lifetimes, edits, and disappearances are core ghost-job signals. Dead postings cannot be re-fetched; this data exists only if we capture it the night it was live.

## 2. Capture points (two)

**(a) Raw bodies — `_http.ts` seam.** `fetchJson`/`postJson` switch internally to `await res.text()` then `JSON.parse(text)` so the raw body string exists, and on success tee `{url, method, status, contentType, body}` to the archive writer (`fetchText` tees the same way). Source identity comes from an `AsyncLocalStorage` context: `crawlOneSource` (`src/server/sources/crawler.ts`) runs the connector's `discover()` drain inside `archiveContext.run({ sourceId, runDate }, ...)`, and `_http` reads that context. **No connector signature changes.** Tee only when a context is present — fetches outside a crawl (e.g. scan-time `fetchDetail`) are not archived.

**(b) Per-posting JSONL — crawler drain.** Where `discover()` is drained per source, each `RawPosting` is appended as one line — `{runDate, sourceId, canonicalKey, posting}` — to that night's `postings.jsonl.gz` (gzip append stream, closed at run end).

## 3. On-disk layout

Root = `CALIBER_ARCHIVE_DIR` (prod: `/var/lib/caliber/archive`, a **new `archive` named volume** in `docker-compose.yml`, sibling of `dbdata`/`uploads`):

```
<root>/YYYY-MM-DD/                     # named by crawl-start date
  responses/<sourceId>/<seq>.json.gz   # one per fetched page; seq increments per source
  postings.jsonl.gz                    # every RawPosting drained that night
  manifest.json                        # runId, startedAt, finishedAt,
                                       # per-source {pages, postings, ok|error}, archiveErrors
```

Each response file holds a JSON envelope `{url, method, status, contentType, fetchedAt, body}` where `body` is the raw response string. Compression via node's built-in `zlib` — no new dependencies. Expected volume: ~15–40 MB/night gzipped (~0.5–1.2 GB/month).

## 4. Config — no fallbacks

Archiving is enabled iff `CALIBER_ARCHIVE_DIR` is set (prod compose sets env + mounts the volume). Unset → archiving disabled with one explicit log line at crawl start (`archive disabled: CALIBER_ARCHIVE_DIR unset`). No invented default path. Dev and tests leave it unset; tests that exercise the writer point it at a temp dir.

## 5. Failure policy

Archive I/O failures never abort the crawl or a source — job discovery outranks the side-channel. Every failure is caught, warn-logged with an `[archive]` prefix (visible to alert-check's log classifier), and counted in a new numeric `archiveErrors` field on `CrawlRunStats` (`crawl_runs.stats`). The manifest is still written best-effort. Nothing is silently swallowed: every failure is logged and counted.

## 6. Backup integration

New step in `scripts/backup.sh` after the uploads step, mirroring the existing pattern: pick the **newest date-dir** under the archive root (`ls | sort | tail -1` — at the 03:17 backup this is the previous evening's 21:00-Berlin crawl), `tar -cf archive-<date>.tar` it (**no `-z`** — contents are already gzipped), `age`-encrypt, `rclone copyto` to `$RCLONE_REMOTE/archive/`. If no date-dir exists (crawl failed or archiving disabled), log and skip — not an error; alert-check already pages on crawl failure itself. Local date-dirs are never pruned (retention decision A); revisit only if disk crosses ~70%.

## 7. Testing

- **Unit:** archive writer (gzip roundtrip, envelope shape, per-source seq increments, JSONL line shape); ALS tagging (fetch inside a context archives, outside does not); disabled mode is a true no-op.
- **Integration:** fixture-connector crawl with `CALIBER_ARCHIVE_DIR` pointed at a temp dir → assert the date-dir, response files, `postings.jsonl.gz`, and manifest counts consistent with `crawl_runs.stats`; a forced write failure increments `archiveErrors` without failing the run.
- **Ops:** `backup.sh` change verified by a manual dry-run on the box at deploy time.

## 8. Out of scope

Archive consumers (DuckDB analysis, night-over-night ghost diffing), retention pruning, R2 lifecycle rules, archiving of scan-time fetches, wave-4 connectors (Recruitee/Getro).
