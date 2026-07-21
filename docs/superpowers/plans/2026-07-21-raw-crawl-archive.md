# Raw Crawl Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every nightly crawl's raw HTTP response bodies and drained postings to disk (and nightly to R2), so future extractor work and the legitimacy engine's longitudinal signals can reprocess crawl history that today is discarded the moment `res.json()` returns, per `docs/superpowers/specs/2026-07-21-raw-crawl-archive-design.md`.

**Architecture:** A new `src/server/sources/archive.ts` module owns an `AsyncLocalStorage` context plus a writer with two capture points: `_http.ts`'s `fetchJson`/`postJson`/`fetchText` tee every raw response body when a context is active, and `crawler.ts`'s `crawlOneSource` runs each source's `discover()` drain inside that context, appending every drained `RawPosting` to a per-night gzip JSONL file. All archive I/O is caught, counted (`archiveErrors` on `CrawlRunStats`), and warn-logged with an `[archive]` prefix — never thrown, so the side-channel can never abort a crawl. Archiving is enabled only when `CALIBER_ARCHIVE_DIR` is set (a new `archive` docker volume in prod); `scripts/backup.sh` copies the newest night's date-dir off-box, encrypted, alongside the existing DB/uploads legs.

**Tech Stack:** Next.js 15 / TypeScript server code (`src/server`), Node's built-in `node:async_hooks` (`AsyncLocalStorage`) and `node:zlib`/`node:fs` (no new npm dependencies), Vitest for unit + integration tests, Docker Compose for the prod volume, bash for `scripts/backup.sh`.

## Global Constraints

- **`CALIBER_ARCHIVE_DIR` gating, no fallback path.** Archiving is enabled iff `process.env.CALIBER_ARCHIVE_DIR` is set. Unset → archiving disabled with exactly one log line (`archive disabled: CALIBER_ARCHIVE_DIR unset`) at crawl start. Never invent a default path (spec §4). Dev and tests leave it unset; tests that exercise the writer point it at a temp dir.
- **`[archive]` log prefix.** Every warn-logged archive failure is prefixed `[archive]` (spec §5 — visible to alert-check's log classifier).
- **`archiveErrors` numeric field.** Added to `CrawlRunStats` (`src/server/persistence/schema.ts`) and `CrawlStats` (`src/server/sources/crawler.ts`) — every archive I/O failure is counted here, never silently swallowed.
- **No new npm dependencies.** Compression is `node:zlib` only (`createGzip`, `gzipSync`, `gunzipSync`) — no new `package.json` entries.
- **Archive I/O failures never abort the crawl or a source.** Job discovery outranks the side-channel (spec §5). Every failure is caught, logged, and counted; the manifest is still written best-effort.
- **On-disk layout, verbatim (spec §3):**
  ```
  <root>/YYYY-MM-DD/                     # named by crawl-start date
    responses/<sourceId>/<seq>.json.gz   # one per fetched page; seq increments per source
    postings.jsonl.gz                    # every RawPosting drained that night
    manifest.json                        # runId, startedAt, finishedAt,
                                         # per-source {pages, postings, ok|error}, archiveErrors
  ```
  `<root>` = `CALIBER_ARCHIVE_DIR`. Prod root = `/var/lib/caliber/archive`, a new `archive` named volume in `docker-compose.yml`, sibling of `dbdata`/`uploads`.
- **Out of scope (spec §8):** archive consumers (DuckDB analysis, night-over-night ghost diffing), retention pruning, R2 lifecycle rules, archiving of scan-time fetches, wave-4 connectors (Recruitee/Getro).

## Deviations from the suggested decomposition

1. **`archiveContext`'s ALS store carries `{sourceId, runDate, writer}`, not just `{sourceId, runDate}`.** `_http.ts` needs to reach the active `ArchiveWriter` with no connector signature changes and no module-level mutable singleton (this codebase's existing style is closures — `createWriterQueue`, `createHostLimiter` — not module globals). Riding the writer along in the ALS context is the only clean seam.
2. **`ArchiveWriter.close(): Promise<void>`, not sync.** The `postings.jsonl.gz` sink is a real streaming `zlib.createGzip()` piped to an `fs.createWriteStream`, kept open across the whole run (spec §2b: "gzip append stream, closed at run end") for a good compression ratio matching the spec's ~15–40 MB/night estimate — per-line independent gzip members would balloon that size. Ending a stream and waiting for `finish` is inherently async, so `runCrawl` must `await writer.close()` before reading `errorCount()`.
3. **Task 3's integration test does not use `src/server/search/connectors/fixture.ts`'s `createFixtureConnector`.** That connector yields postings from an in-memory map and never calls `_http.ts` — it cannot exercise capture point (a), the response tee. The integration test defines a small inline connector that calls the real `fetchJson` against a mocked global `fetch`, exercising both capture points end-to-end.
4. **`scripts/backup.sh` gets a new, self-contained step 3b** (rather than folding into the existing shared encrypt/off-box steps) with its own `if`-guard, since `set -euo pipefail` requires the "archiving disabled or no date-dir" skip path to be explicit, not implicit.

## File structure

| File | Responsibility |
|---|---|
| `src/server/sources/archive.ts` | `archiveContext` (ALS), `startArchiveRun`, `ArchiveWriter` and its types. |
| `src/server/sources/archive.test.ts` | Unit tests: gzip roundtrip, seq increments, JSONL shape, forced-failure counting, disabled no-op. |
| `src/server/search/connectors/_http.ts` (modify) | `fetchJson`/`postJson`/`fetchText` read `res.text()` + tee to the active writer on success. |
| `src/server/search/connectors/_http.test.ts` | Tee-inside-context / no-tee-outside-context / no-tee-on-error tests. |
| `src/server/sources/crawler.ts` (modify) | `crawlOneSource` runs the drain inside `archiveContext.run(...)`; `drain()` takes an `onEach` callback; run start/end wiring; `CrawlStats.archiveErrors`. |
| `src/server/persistence/schema.ts` (modify) | `CrawlRunStats.archiveErrors: number`. |
| `src/server/sources/archive-integration.test.ts` | Fixture-crawl integration test against a temp `CALIBER_ARCHIVE_DIR`. |
| `docker-compose.yml` (modify) | New `archive` named volume + `CALIBER_ARCHIVE_DIR` env on `app`. |
| `DEPLOY.md` (modify) | Short note on the archive root + volume. |
| `scripts/backup.sh` (modify) | New step 3b: newest date-dir → tar (no `-z`) → age-encrypt → `rclone copyto`. |

---

## Task 1: Archive writer module (spec §2, §3, §5)

**Files:**
- Create: `src/server/sources/archive.ts`
- Test: `src/server/sources/archive.test.ts`

**Read first (patterns this mirrors):**
- `src/server/resume/uploads.ts` — the "env var, no `process.cwd()` fallback" idiom (not copied verbatim here — this module is deliberately non-fail-loud per spec §4, since an unset `CALIBER_ARCHIVE_DIR` is a valid, expected "disabled" state, not an error).
- `src/server/sources/crawler.ts:178-188` (`createWriterQueue`) and `:140-172` (`createHostLimiter`) — this codebase's closure-factory style (`function createX() { ...; return {...}; }`) instead of module-level mutable singletons. `archive.ts` follows the same shape for `createEnabledWriter`/`createDisabledWriter`.

**Interfaces:**
- Consumes: nothing from earlier tasks (first task).
- Produces:
  - `export interface ArchiveResponseEnvelope { url: string; method: string; status: number; contentType: string | null; body: string; fetchedAt: string }`
  - `export interface ArchivePostingLine { runDate: string; sourceId: string; canonicalKey: string; posting: unknown }`
  - `export interface ArchiveManifestInput { runId: string; startedAt: string; finishedAt: string; perSourceStatus: Record<string, "ok" | "error"> }`
  - `export interface ArchiveWriter { archiveResponse(sourceId: string, envelope: ArchiveResponseEnvelope): void; appendPosting(line: ArchivePostingLine): void; writeManifest(input: ArchiveManifestInput): void; errorCount(): number; close(): Promise<void> }`
  - `export const archiveContext: AsyncLocalStorage<{ sourceId: string; runDate: string; writer: ArchiveWriter }>`
  - `export function startArchiveRun(dir: string | undefined, runDate: string): ArchiveWriter`
  - Task 2 imports `archiveContext`. Task 3 imports `archiveContext`, `startArchiveRun`.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/sources/archive.test.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startArchiveRun } from "./archive";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "caliber-archive-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function readGunzipped(path: string): string {
  return gunzipSync(readFileSync(path)).toString("utf-8");
}

describe("startArchiveRun — disabled mode", () => {
  it("is a true no-op when dir is undefined: no throw, errorCount stays 0, no files written", async () => {
    const writer = startArchiveRun(undefined, "2026-07-21");
    writer.archiveResponse("src1", { url: "https://x", method: "GET", status: 200, contentType: "application/json", body: "{}", fetchedAt: "2026-07-21T00:00:00.000Z" });
    writer.appendPosting({ runDate: "2026-07-21", sourceId: "src1", canonicalKey: "ck-1", posting: { a: 1 } });
    writer.writeManifest({ runId: "r1", startedAt: "s", finishedAt: "f", perSourceStatus: { src1: "ok" } });
    expect(writer.errorCount()).toBe(0);
    await expect(writer.close()).resolves.toBeUndefined();
    expect(existsSync(join(root, "2026-07-21"))).toBe(false); // root never touched
  });
});

describe("startArchiveRun — enabled mode", () => {
  it("gzip-roundtrips a response envelope under responses/<sourceId>/1.json.gz", () => {
    const writer = startArchiveRun(root, "2026-07-21");
    const envelope = { url: "https://boards-api.greenhouse.io/v1/boards/acme/jobs", method: "GET", status: 200, contentType: "application/json", body: '{"jobs":[]}', fetchedAt: "2026-07-21T03:00:00.000Z" };
    writer.archiveResponse("greenhouse", envelope);

    const file = join(root, "2026-07-21", "responses", "greenhouse", "1.json.gz");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readGunzipped(file))).toEqual(envelope);
    expect(writer.errorCount()).toBe(0);
  });

  it("increments seq per source independently", () => {
    const writer = startArchiveRun(root, "2026-07-21");
    const envelope = (n: number) => ({ url: `https://x/${n}`, method: "GET", status: 200, contentType: null, body: `${n}`, fetchedAt: "2026-07-21T00:00:00.000Z" });
    writer.archiveResponse("greenhouse", envelope(1));
    writer.archiveResponse("greenhouse", envelope(2));
    writer.archiveResponse("lever", envelope(1));

    expect(existsSync(join(root, "2026-07-21", "responses", "greenhouse", "1.json.gz"))).toBe(true);
    expect(existsSync(join(root, "2026-07-21", "responses", "greenhouse", "2.json.gz"))).toBe(true);
    expect(existsSync(join(root, "2026-07-21", "responses", "lever", "1.json.gz"))).toBe(true);
    expect(JSON.parse(readGunzipped(join(root, "2026-07-21", "responses", "lever", "1.json.gz"))).body).toBe("1");
  });

  it("appends every posting as one gzip-JSONL line, closed at run end", async () => {
    const writer = startArchiveRun(root, "2026-07-21");
    writer.appendPosting({ runDate: "2026-07-21", sourceId: "greenhouse", canonicalKey: "ck-1", posting: { title: "Engineer" } });
    writer.appendPosting({ runDate: "2026-07-21", sourceId: "greenhouse", canonicalKey: "ck-2", posting: { title: "Designer" } });
    await writer.close();

    const lines = readGunzipped(join(root, "2026-07-21", "postings.jsonl.gz")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { runDate: "2026-07-21", sourceId: "greenhouse", canonicalKey: "ck-1", posting: { title: "Engineer" } },
      { runDate: "2026-07-21", sourceId: "greenhouse", canonicalKey: "ck-2", posting: { title: "Designer" } },
    ]);
    expect(writer.errorCount()).toBe(0);
  });

  it("counts (never throws) a forced write failure: a FILE blocking the per-source responses dir", () => {
    mkdirSync(join(root, "2026-07-21", "responses"), { recursive: true });
    writeFileSync(join(root, "2026-07-21", "responses", "greenhouse"), "blocking file, not a dir");

    const writer = startArchiveRun(root, "2026-07-21");
    expect(() =>
      writer.archiveResponse("greenhouse", { url: "https://x", method: "GET", status: 200, contentType: null, body: "{}", fetchedAt: "2026-07-21T00:00:00.000Z" }),
    ).not.toThrow();
    expect(writer.errorCount()).toBe(1);
  });

  it("writeManifest assembles runId/startedAt/finishedAt/perSource/archiveErrors from tracked counts", async () => {
    const writer = startArchiveRun(root, "2026-07-21");
    writer.archiveResponse("greenhouse", { url: "https://x", method: "GET", status: 200, contentType: null, body: "{}", fetchedAt: "2026-07-21T00:00:00.000Z" });
    writer.appendPosting({ runDate: "2026-07-21", sourceId: "greenhouse", canonicalKey: "ck-1", posting: {} });
    writer.appendPosting({ runDate: "2026-07-21", sourceId: "greenhouse", canonicalKey: "ck-2", posting: {} });
    await writer.close();
    writer.writeManifest({ runId: "run-1", startedAt: "2026-07-21T03:00:00.000Z", finishedAt: "2026-07-21T03:05:00.000Z", perSourceStatus: { greenhouse: "ok" } });

    const manifest = JSON.parse(readFileSync(join(root, "2026-07-21", "manifest.json"), "utf-8"));
    expect(manifest).toEqual({
      runId: "run-1",
      startedAt: "2026-07-21T03:00:00.000Z",
      finishedAt: "2026-07-21T03:05:00.000Z",
      perSource: { greenhouse: { pages: 1, postings: 2, status: "ok" } },
      archiveErrors: 0,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/sources/archive.test.ts`
Expected: FAIL — `Cannot find module './archive'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/server/sources/archive.ts
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
        out.on("finish", () => resolve());
        gzip.end();
      });
    },
  };
}

export function startArchiveRun(dir: string | undefined, runDate: string): ArchiveWriter {
  if (!dir) return createDisabledWriter();
  return createEnabledWriter(dir, runDate);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/sources/archive.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/sources/archive.ts src/server/sources/archive.test.ts
git commit -m "$(cat <<'EOF'
feat(archive): archive writer module (ALS context, gzip responses + JSONL)

Claude-Session: https://claude.ai/code/session_01GLFjNNLAhkC74ZX5dMzKFT
EOF
)"
```

---

## Task 2: `_http.ts` raw-body tee (spec §2a)

**Files:**
- Modify: `src/server/search/connectors/_http.ts`
- Test: `src/server/search/connectors/_http.test.ts` (new)

**Read first:**
- `src/server/search/connectors/_http.ts` (whole file — already read in full above): `fetchJson`/`postJson` currently call `res.json()` directly on success and only read `res.text()` (via `.catch(() => "")`) on the error path to build the `ConnectorHttpError` message. `fetchText` already always reads `res.text()`.
- `src/server/search/connectors/greenhouse.test.ts:1-30, 46-48` — the `vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(...)))` + `afterEach(() => vi.unstubAllGlobals())` convention this test file follows exactly.

**Interfaces:**
- Consumes: `archiveContext` (Task 1, `../../sources/archive` — relative path from `src/server/search/connectors/_http.ts` to `src/server/sources/archive.ts` is `../../sources/archive`).
- Produces: no new exports — `fetchJson`/`postJson`/`fetchText` keep their existing signatures (no connector signature changes, per spec §2a). Internal behavior only: body is now always read via `res.text()` then `JSON.parse`'d (for the two JSON functions), and a successful response is teed to the active writer when `archiveContext.getStore()` is present.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/search/connectors/_http.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { archiveContext, type ArchiveWriter } from "@/server/sources/archive";
import { ConnectorHttpError, fetchJson, fetchText, postJson } from "./_http";

function fakeWriter(): ArchiveWriter {
  return {
    archiveResponse: vi.fn(),
    appendPosting: vi.fn(),
    writeManifest: vi.fn(),
    errorCount: () => 0,
    close: () => Promise.resolve(),
  };
}

describe("_http archive tee", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchJson tees the raw body when called inside an archive context", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ a: 1 }), { status: 200, headers: { "content-type": "application/json" } })),
    );
    const writer = fakeWriter();

    const result = await archiveContext.run({ sourceId: "src1", runDate: "2026-07-21", writer }, () =>
      fetchJson("https://example.com/x"),
    );

    expect(result).toEqual({ a: 1 });
    expect(writer.archiveResponse).toHaveBeenCalledTimes(1);
    expect(writer.archiveResponse).toHaveBeenCalledWith(
      "src1",
      expect.objectContaining({
        url: "https://example.com/x",
        method: "GET",
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ a: 1 }),
      }),
    );
  });

  it("fetchJson does NOT tee when called outside an archive context", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ a: 1 }), { status: 200 })));
    const writer = fakeWriter();

    const result = await fetchJson("https://example.com/x"); // no archiveContext.run wrapper

    expect(result).toEqual({ a: 1 });
    expect(writer.archiveResponse).not.toHaveBeenCalled();
  });

  it("fetchJson does NOT tee on a non-2xx response, even inside a context", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));
    const writer = fakeWriter();

    await expect(
      archiveContext.run({ sourceId: "src1", runDate: "2026-07-21", writer }, () => fetchJson("https://example.com/x")),
    ).rejects.toThrow(ConnectorHttpError);
    expect(writer.archiveResponse).not.toHaveBeenCalled();
  });

  it("postJson tees the raw body on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })),
    );
    const writer = fakeWriter();

    await archiveContext.run({ sourceId: "src1", runDate: "2026-07-21", writer }, () =>
      postJson("https://example.com/search", { q: "engineer" }),
    );

    expect(writer.archiveResponse).toHaveBeenCalledWith(
      "src1",
      expect.objectContaining({ url: "https://example.com/search", method: "POST", status: 200, body: JSON.stringify({ ok: true }) }),
    );
  });

  it("fetchText tees the raw body on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>plain</html>", { status: 200, headers: { "content-type": "text/html" } })));
    const writer = fakeWriter();

    const result = await archiveContext.run({ sourceId: "src1", runDate: "2026-07-21", writer }, () =>
      fetchText("https://example.com/page"),
    );

    expect(result).toBe("<html>plain</html>");
    expect(writer.archiveResponse).toHaveBeenCalledWith(
      "src1",
      expect.objectContaining({ url: "https://example.com/page", method: "GET", status: 200, body: "<html>plain</html>" }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/search/connectors/_http.test.ts`
Expected: FAIL — `writer.archiveResponse` never called (tee not implemented yet).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/server/search/connectors/_http.ts
// Shared HTTP transport for connectors — TS port of career-ops/providers/
// _http.mjs's fetchJson (timeout + user-agent + non-2xx → thrown Error).
// Files prefixed with `_` are helpers, not connectors themselves.
//
// Raw-body tee (2026-07-21-raw-crawl-archive-design.md §2a): fetchJson/
// postJson/fetchText all read the body as text first, then on a 2xx response
// tee {url,method,status,contentType,body,fetchedAt} to the active archive
// writer — but ONLY when archiveContext has a store (a crawl is running).
// No connector signature changes; a fetch outside a crawl (e.g. scan-time
// fetchDetail) is never archived.
import { archiveContext } from "../../sources/archive";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; caliber/1.0)";

export interface FetchJsonOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  redirect?: RequestRedirect;
  signal?: AbortSignal;
}

export class ConnectorHttpError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ConnectorHttpError";
    this.status = status;
  }
}

function teeResponse(url: string, method: string, res: Response, body: string): void {
  const ctx = archiveContext.getStore();
  if (!ctx) return;
  ctx.writer.archiveResponse(ctx.sourceId, {
    url,
    method,
    status: res.status,
    contentType: res.headers.get("content-type"),
    body,
    fetchedAt: new Date().toISOString(),
  });
}

export async function fetchJson(url: string, opts: FetchJsonOptions = {}): Promise<unknown> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, redirect = "follow", signal } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "user-agent": DEFAULT_USER_AGENT, ...headers },
      redirect,
      signal: combined,
    });
    const bodyText = await res.text().catch(() => "");
    if (!res.ok) {
      throw new ConnectorHttpError(`HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 300)}` : ""}`, res.status);
    }
    teeResponse(url, "GET", res, bodyText);
    return JSON.parse(bodyText);
  } finally {
    clearTimeout(timer);
  }
}

export async function postJson(url: string, body: unknown, opts: FetchJsonOptions = {}): Promise<unknown> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, signal } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "user-agent": DEFAULT_USER_AGENT, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: combined,
    });
    const bodyText = await res.text().catch(() => "");
    if (!res.ok) {
      throw new ConnectorHttpError(`HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 300)}` : ""}`, res.status);
    }
    teeResponse(url, "POST", res, bodyText);
    return JSON.parse(bodyText);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchText(url: string, opts: FetchJsonOptions = {}): Promise<string> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, redirect = "follow", signal } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "user-agent": DEFAULT_USER_AGENT, ...headers },
      redirect,
      signal: combined,
    });
    const bodyText = await res.text();
    if (!res.ok) {
      throw new ConnectorHttpError(`HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 300)}` : ""}`, res.status);
    }
    teeResponse(url, "GET", res, bodyText);
    return bodyText;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run test to verify it passes, then run the full connector suite (regression check for the `res.json()` → `res.text()`+`JSON.parse` switch)**

Run: `npx vitest run src/server/search/connectors/_http.test.ts`
Expected: PASS (5 tests).

Run: `npx vitest run src/server/search/connectors`
Expected: PASS — every existing greenhouse/lever/ashby/jobstreet/smartrecruiters/fixture/index test still green (behavior-preserving switch from `res.json()` to `res.text()` + `JSON.parse`).

- [ ] **Step 5: Commit**

```bash
git add src/server/search/connectors/_http.ts src/server/search/connectors/_http.test.ts
git commit -m "$(cat <<'EOF'
feat(archive): tee raw HTTP responses from _http.ts when a crawl context is active

Claude-Session: https://claude.ai/code/session_01GLFjNNLAhkC74ZX5dMzKFT
EOF
)"
```

---

## Task 3: Crawler integration (spec §2b, §4, §5, §7)

**Files:**
- Modify: `src/server/sources/crawler.ts`
- Modify: `src/server/persistence/schema.ts`
- Test: `src/server/sources/archive-integration.test.ts` (new)

**Read first:**
- `src/server/sources/crawler.ts:190-194` (`drain`), `:343-452` (`runCrawl`), `:377-430` (`crawlOneSource`) — already read in full above; this task's edits touch exactly these three regions.
- `src/server/persistence/schema.ts:87-101` (`CrawlRunStats`) — already read in full above.
- `src/server/sources/crawler.test.ts:1-52` — the `connectorFactory`/`rawPosting` test-double conventions this codebase already uses for `runCrawl` tests (not reused verbatim here, since this task's integration test needs a connector that actually calls `_http.ts`, which none of `crawler.test.ts`'s fakes do).
- `src/server/persistence/repos/__fixtures__/helpers.ts:12-28` (`insertSource`) and `src/server/persistence/test-db.ts` (`createTestDb`) — reused as-is.
- `src/server/sources/dedupe-global.ts:39-47` (`crossBoardKey`) — confirms two `RawPosting`s from the same source with the same `company`+`title`+`location` collapse into ONE `postings` upsert (via `groupBoardPostings` in `crawler.ts`), even though BOTH are still archived individually pre-collapse. This is why the integration test below expects `postings: 2` in the manifest but `upserts: 1` in `crawl_runs.stats`.

**Interfaces:**
- Consumes: `archiveContext`, `startArchiveRun`, `ArchiveWriter` (Task 1, `./archive`); `canonicalKey` (already imported in `crawler.ts` from `./dedupe-global`).
- Produces: `CrawlStats.archiveErrors: number` (crawler.ts) and `CrawlRunStats.archiveErrors: number` (schema.ts) — both consumed by `crawl.ts`'s existing log line (unchanged; `result.stats.archiveErrors` is now a valid field, no log-line edit required by this task) and by the admin crawl-status surface's existing `stats` passthrough (no other code reads named fields off `CrawlRunStats` that would break from an added field).

- [ ] **Step 1: Write the failing test**

```ts
// src/server/sources/archive-integration.test.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertSource } from "../persistence/repos/__fixtures__/helpers";
import type { SourceRow } from "../persistence/repos/sources";
import { createTestDb } from "../persistence/test-db";
import type { RawPosting, SourceConnector } from "../search/connector";
import { fetchJson } from "../search/connectors/_http";
import { runCrawl } from "./crawler";

// Unlike src/server/search/connectors/fixture.ts's createFixtureConnector
// (which yields from an in-memory map and never touches _http.ts), this
// connector calls the REAL fetchJson so the archive's response-tee capture
// point (a) is actually exercised end-to-end, not bypassed.
function connectorViaHttp(source: SourceRow): SourceConnector {
  return {
    id: source.id,
    kind: source.kind,
    persona: source.persona,
    async *discover() {
      const data = (await fetchJson(`https://example.com/${source.id}/jobs`)) as { jobs: RawPosting[] };
      for (const p of data.jobs) yield p;
    },
  };
}

// Same company/title/location on purpose: crossBoardKey collapses these two
// into ONE canonical postings row (dedupe-global.ts), so upserts=1 even
// though both are archived individually pre-collapse (postings=2).
function rawPosting(sourceId: string, seq: number): RawPosting {
  return {
    sourceId,
    externalId: `ext-${seq}`,
    url: `https://jobs.example.com/${sourceId}/${seq}`,
    title: "Senior Backend Engineer",
    company: "acme",
    location: "Remote",
  };
}

describe("crawl archive integration (2026-07-21-raw-crawl-archive-design.md §7)", () => {
  let root: string;
  const originalDir = process.env.CALIBER_ARCHIVE_DIR;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "caliber-archive-it-"));
    process.env.CALIBER_ARCHIVE_DIR = root;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const sourceId = url.split("/")[3];
        return new Response(JSON.stringify({ jobs: [rawPosting(sourceId, 1), rawPosting(sourceId, 2)] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalDir === undefined) delete process.env.CALIBER_ARCHIVE_DIR;
    else process.env.CALIBER_ARCHIVE_DIR = originalDir;
    rmSync(root, { recursive: true, force: true });
  });

  it("writes the date-dir, response files, postings.jsonl.gz, and a manifest consistent with crawl_runs.stats", async () => {
    const db = await createTestDb();
    const source = await insertSource(db, { config: { connector: "ashby", geo: { scope: "restricted" } } });

    const before = Date.now();
    const result = await runCrawl({ db, sources: [source], connectorFor: connectorViaHttp });
    const runDate = new Date(before).toISOString().slice(0, 10);

    expect(result.status).toBe("completed");
    expect(result.stats.archiveErrors).toBe(0);
    expect(result.stats.upserts).toBe(1); // two RawPostings collapse via crossBoardKey

    const dateDir = join(root, runDate);
    expect(existsSync(dateDir)).toBe(true);

    const responseFile = join(dateDir, "responses", source.id, "1.json.gz");
    expect(existsSync(responseFile)).toBe(true);
    const envelope = JSON.parse(gunzipSync(readFileSync(responseFile)).toString("utf-8"));
    expect(envelope).toMatchObject({ url: `https://example.com/${source.id}/jobs`, method: "GET", status: 200, contentType: "application/json" });
    expect(JSON.parse(envelope.body).jobs).toHaveLength(2);

    const postingsLines = gunzipSync(readFileSync(join(dateDir, "postings.jsonl.gz")))
      .toString("utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(postingsLines).toHaveLength(2);
    expect(postingsLines[0]).toMatchObject({ runDate, sourceId: source.id });
    expect(typeof postingsLines[0].canonicalKey).toBe("string");

    const manifest = JSON.parse(readFileSync(join(dateDir, "manifest.json"), "utf-8"));
    expect(manifest.runId).toBe(result.runId);
    expect(manifest.archiveErrors).toBe(0);
    expect(manifest.perSource[source.id]).toEqual({ pages: 1, postings: 2, status: "ok" });
  });

  it("a forced archive write failure increments archiveErrors without failing the run", async () => {
    const db = await createTestDb();
    const source = await insertSource(db, { config: { connector: "ashby", geo: { scope: "restricted" } } });
    const runDate = new Date().toISOString().slice(0, 10);

    // Pre-create a FILE where the per-source responses dir needs to go, so
    // mkdirSync(..., {recursive:true}) throws ENOTDIR inside archiveResponse
    // — a deterministic, synchronous forced failure (mirrors archive.test.ts).
    mkdirSync(join(root, runDate, "responses"), { recursive: true });
    writeFileSync(join(root, runDate, "responses", source.id), "blocking file, not a dir");

    const result = await runCrawl({ db, sources: [source], connectorFor: connectorViaHttp });

    expect(result.status).toBe("completed"); // the crawl itself is untouched
    expect(result.stats.archiveErrors).toBeGreaterThan(0);
    expect(result.stats.upserts).toBe(1); // posting upsert path is unaffected
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/sources/archive-integration.test.ts`
Expected: FAIL — `result.stats.archiveErrors` is `undefined` (not yet on `CrawlStats`), no date-dir written.

- [ ] **Step 3: Write minimal implementation**

In `src/server/persistence/schema.ts`, modify `CrawlRunStats` (lines 87-101):

```ts
type CrawlRunStats = {
  sourcesOk: number;
  sourcesFailed: number;
  perHostBackoffs: Record<string, number>;
  upserts: number;
  delists: number;
  durationMs: number;
  // Source ids whose fetch succeeded but returned zero postings — an anomaly
  // flag, never a delist signal (a bad slug or empty vendor payload must not
  // read as "the whole board vanished").
  emptyFetches: string[];
  // Source ids whose fetch failed, with the thrown error's message (truncated
  // ~200 chars) — sourcesFailed's count alone doesn't say which board or why.
  failedSources: { id: string; error: string }[];
  // Archive I/O failure count for this run (2026-07-21-raw-crawl-archive-
  // design.md §5) — never aborts the crawl; every archive failure is caught,
  // warn-logged (`[archive]` prefix), and counted here instead.
  archiveErrors: number;
};
```

In `src/server/sources/crawler.ts`:

1. Add the import, right after the existing `_http` import:

```ts
import { ConnectorHttpError } from "../search/connectors/_http";
import { archiveContext, startArchiveRun } from "./archive";
```

2. Add `archiveErrors: number;` to the `CrawlStats` interface, right after `failedSources`:

```ts
  failedSources: { id: string; error: string }[];
  // Archive I/O failure count (2026-07-21-raw-crawl-archive-design.md §5) —
  // mirrors CrawlRunStats.archiveErrors; archive failures never abort the crawl.
  archiveErrors: number;
}
```

3. Replace `drain` (lines 190-194):

```ts
async function drain(iter: AsyncIterable<RawPosting>, onEach?: (posting: RawPosting) => void): Promise<RawPosting[]> {
  const out: RawPosting[] = [];
  for await (const posting of iter) {
    onEach?.(posting);
    out.push(posting);
  }
  return out;
}
```

4. Replace the whole `runCrawl` function (lines 343-452) with:

```ts
export async function runCrawl(deps: CrawlDeps): Promise<CrawlRunResult> {
  const now = deps.now ?? (() => Date.now());
  const { db, connectorFor } = deps;
  const hostFor = deps.hostFor ?? defaultHostFor;
  const concurrency = deps.concurrencyPerHost ?? DEFAULT_CONCURRENCY_PER_HOST;
  const purgeMs = deps.purgeOlderThanMs ?? PURGE_MS;
  const leaseMs = deps.leaseMs ?? LEASE_MS;
  const signal = deps.signal;

  const runStartedAt = now();
  const stats: CrawlStats = {
    sourcesOk: 0,
    sourcesFailed: 0,
    perHostBackoffs: {},
    upserts: 0,
    delists: 0,
    durationMs: 0,
    emptyFetches: [],
    failedSources: [],
    archiveErrors: 0,
  };
  let sourcesSkipped = 0;
  let purged = 0;

  const leaseId = await acquireLease(db, runStartedAt, leaseMs);
  if (!leaseId) {
    // Overlap protection: another run holds the lease. Do nothing (no row
    // created, no writes) — F6.
    return { runId: null, status: "skipped", stats, purged: 0, sourcesSkipped: deps.sources.length };
  }

  // Raw crawl archive (2026-07-21-raw-crawl-archive-design.md §4): enabled
  // iff CALIBER_ARCHIVE_DIR is set — no invented default path. Disabled logs
  // one explicit line; startArchiveRun returns an inert no-op writer either
  // way, so the rest of this function never branches on enabled/disabled.
  const archiveDir = process.env.CALIBER_ARCHIVE_DIR;
  if (!archiveDir) console.log("archive disabled: CALIBER_ARCHIVE_DIR unset");
  const runDate = new Date(runStartedAt).toISOString().slice(0, 10);
  const writer = startArchiveRun(archiveDir, runDate);
  // sourceId -> this run's fetch outcome, fed to writer.writeManifest at the
  // end (§3 manifest per-source ok|error) — the writer itself only knows
  // pages/postings counts, not fetch success/failure.
  const perSourceStatus: Record<string, "ok" | "error"> = {};

  const stoppedHosts = new Set<string>();
  const limiter = createHostLimiter(concurrency);
  const write = createWriterQueue();

  async function crawlOneSource(source: SourceRow): Promise<void> {
    const host = hostFor(source);
    // A host stopped earlier this run (403/429) is never re-hit — its remaining
    // sources are skipped, left stale (never delisted, arch §2.2).
    if (stoppedHosts.has(host)) {
      sourcesSkipped += 1;
      return;
    }
    let boardPostings: RawPosting[];
    try {
      // Archive capture point (a): _http.ts tees every raw response while
      // this source's discover() drain runs inside this context (§2a).
      boardPostings = await archiveContext.run({ sourceId: source.id, runDate, writer }, () =>
        drain(
          connectorFor(source).discover({
            targets: [],
            since: new Date(0),
            signal: signal ?? new AbortController().signal,
            onProgress: () => {},
          }),
          // Archive capture point (b): every drained RawPosting, pre-collapse,
          // appended to postings.jsonl.gz (§2b) — before groupBoardPostings
          // ever collapses same-opening duplicates.
          (p) => writer.appendPosting({ runDate, sourceId: source.id, canonicalKey: canonicalKey(p), posting: p }),
        ),
      );
    } catch (err) {
      if (isBackoffStatus(err)) {
        stoppedHosts.add(host);
        stats.perHostBackoffs[host] = (stats.perHostBackoffs[host] ?? 0) + 1;
      }
      stats.sourcesFailed += 1;
      perSourceStatus[source.id] = "error";
      const errorMessage = err instanceof Error ? err.message : String(err);
      stats.failedSources.push({ id: source.id, error: errorMessage.slice(0, FAILED_SOURCE_ERROR_CAP) });
      // Recorded, not thrown — a failing source must not abort the crawl (F1),
      // and a failed fetch NEVER triggers the delist sweep below.
      console.error(`crawl ${leaseId}: source "${source.id}" fetch failed:`, err);
      return;
    }

    // Fetch succeeded: writes drain through the single sequential queue. The
    // delist sweep is inside the SAME enqueued block, so it is gated on this
    // source's fetch success by construction.
    await write(async () => {
      const winners = groupBoardPostings(source, boardPostings, tierFor(source));
      for (const winner of winners) {
        await upsertPosting(db, source, winner, now());
        stats.upserts += 1;
      }
      if (boardPostings.length === 0) {
        // A zero-posting fetch is a visible anomaly (bad slug, transient empty
        // vendor payload) — NOT a signal that every live row for this source
        // just vanished from the board. Skip the sweep; record + log it loudly
        // instead of silently mass-delisting.
        stats.emptyFetches.push(source.id);
        console.warn(`crawl ${leaseId}: source "${source.id}" fetch returned 0 postings — skipping delist sweep`);
      } else {
        stats.delists += await delistSweep(db, source.id, runStartedAt, now());
      }
    });
    perSourceStatus[source.id] = "ok";
    stats.sourcesOk += 1;
  }

  try {
    await Promise.all(deps.sources.map((source) => limiter(hostFor(source), () => crawlOneSource(source))));
    purged = await write(() => purge(db, now() - purgeMs));
    const finishedAt = now();
    stats.durationMs = finishedAt - runStartedAt;
    await writer.close();
    writer.writeManifest({
      runId: leaseId,
      startedAt: new Date(runStartedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      perSourceStatus,
    });
    stats.archiveErrors = writer.errorCount();
    await db
      .update(crawlRuns)
      .set({ status: "completed", finishedAt: new Date(finishedAt), stats })
      .where(eq(crawlRuns.id, leaseId));
    return { runId: leaseId, status: "completed", stats, purged, sourcesSkipped };
  } catch (err) {
    // An infrastructure failure (e.g. a DB write error) — distinct from a
    // per-source fetch failure, which crawlOneSource already absorbed. Record
    // the run as failed (fail loud) and re-throw.
    const finishedAt = now();
    stats.durationMs = finishedAt - runStartedAt;
    await writer.close();
    writer.writeManifest({
      runId: leaseId,
      startedAt: new Date(runStartedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      perSourceStatus,
    });
    stats.archiveErrors = writer.errorCount();
    await db
      .update(crawlRuns)
      .set({ status: "failed", finishedAt: new Date(finishedAt), stats })
      .where(eq(crawlRuns.id, leaseId));
    throw err;
  }
}
```

- [ ] **Step 4: Run test to verify it passes, then run the full crawler + schema suites (regression check)**

Run: `npx vitest run src/server/sources/archive-integration.test.ts`
Expected: PASS (2 tests).

Run: `npx vitest run src/server/sources/crawler.test.ts`
Expected: PASS — every existing `runCrawl` test still green (archive is inert with `CALIBER_ARCHIVE_DIR` unset in that file's environment).

Run: `npx tsc --noEmit`
Expected: PASS — `CrawlRunStats`/`CrawlStats` shape stays structurally compatible (schema.ts's private `CrawlRunStats` type and crawler.ts's `CrawlStats` are duck-typed, not imported from each other, per the existing `crawler.ts:46-48` comment).

- [ ] **Step 5: Commit**

```bash
git add src/server/sources/crawler.ts src/server/persistence/schema.ts src/server/sources/archive-integration.test.ts
git commit -m "$(cat <<'EOF'
feat(archive): wire crawlOneSource's drain through the archive context

Claude-Session: https://claude.ai/code/session_01GLFjNNLAhkC74ZX5dMzKFT
EOF
)"
```

---

## Task 4: Compose volume + deploy docs (spec §3, §4)

**Files:**
- Modify: `docker-compose.yml`
- Modify: `DEPLOY.md`

**Read first:**
- `docker-compose.yml` (whole file, already read in full above) — the `app.volumes`/`app.environment`/top-level `volumes:` shape `uploads`/`dbdata` already follow.
- `DEPLOY.md:7-11` (Architecture constraints) — the "Uploads root = `CALIBER_UPLOADS_DIR`..." bullet this task adds a sibling bullet next to.

**Interfaces:** None (infrastructure config + docs only — no code, no tests).

- [ ] **Step 1: Modify `docker-compose.yml`**

In the `app.environment` block, add `CALIBER_ARCHIVE_DIR` right after `CALIBER_UPLOADS_DIR`:

```yaml
    environment:
      # Non-secret runtime config (secrets live in .env.production):
      DATABASE_URL: file:/var/lib/caliber/data/caliber.db
      CALIBER_UPLOADS_DIR: /var/lib/caliber/uploads
      CALIBER_ARCHIVE_DIR: /var/lib/caliber/archive
      SESSION_COOKIE_SECURE: "true"   # served over HTTPS via caddy
      NODE_ENV: production
```

In `app.volumes`, add the `archive` mount right after `uploads`:

```yaml
    volumes:
      - uploads:/var/lib/caliber/uploads   # persist résumé files across deploys
      - archive:/var/lib/caliber/archive   # nightly raw-crawl archive (2026-07-21-raw-crawl-archive-design.md)
      - dbdata:/var/lib/caliber/data       # persist caliber.db (+ -wal/-shm) across deploys
```

In the top-level `volumes:` section, add `archive:` right after `uploads:`:

```yaml
volumes:
  dbdata:
  uploads:
  archive:
  caddy_data:
  caddy_config:
```

- [ ] **Step 2: Modify `DEPLOY.md`**

In the "Architecture constraints (do not violate)" section, add a bullet right after the existing "Uploads root" bullet (line 11):

```markdown
- **Uploads root** = `CALIBER_UPLOADS_DIR` (`/var/lib/caliber/uploads`), a persistent volume/bind-mount. Résumé files are stored under per-user relative keys (Step 5), so a host move is a pure `rsync` with zero DB rewriting.
- **Archive root** = `CALIBER_ARCHIVE_DIR` (`/var/lib/caliber/archive`), a persistent volume holding the nightly raw-crawl archive (see `docs/superpowers/specs/2026-07-21-raw-crawl-archive-design.md`). Unset in dev/tests — archiving disables cleanly with one log line (`archive disabled: CALIBER_ARCHIVE_DIR unset`), never a fabricated default path.
```

- [ ] **Step 3: Verify the compose file parses**

Run: `docker compose config > /dev/null && echo OK`
Expected: `OK` — `docker-compose.yml` is valid YAML and the new `archive` volume/env resolve (no `${...}` interpolation errors).

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml DEPLOY.md
git commit -m "$(cat <<'EOF'
feat(archive): archive volume + CALIBER_ARCHIVE_DIR in prod compose

Claude-Session: https://claude.ai/code/session_01GLFjNNLAhkC74ZX5dMzKFT
EOF
)"
```

---

## Task 5: `backup.sh` archive leg (spec §6)

**Files:**
- Modify: `scripts/backup.sh`

**Read first:** `scripts/backup.sh` (whole file, already read in full above) — step 3 (`docker compose cp app:/var/lib/caliber/uploads "$WORK/uploads"` → `tar -czf`), step 4 (`age -r ... -o ...`), step 5 (`rclone copyto`). This task's new step 3b mirrors step 3's `docker compose cp` idiom; steps 4/5 gain an `if`-guarded archive leg alongside the existing db/uploads legs.

**Interfaces:** None (bash script only — no code, no tests; ops verification is deferred to deploy per the spec's own §7 "Ops: `backup.sh` change verified by a manual dry-run on the box at deploy time").

- [ ] **Step 1: Insert the new step 3b, right after step 3 (uploads) and before step 4 (encrypt)**

```bash
# 3. Uploads (the volume is already in the nightly cron per the consolidation
#    doc — this adds the off-box + encrypted leg).
docker compose cp app:/var/lib/caliber/uploads "$WORK/uploads"
tar -czf "$WORK/uploads-$STAMP.tar.gz" -C "$WORK" uploads

# 3b. Raw crawl archive (2026-07-21-raw-crawl-archive-design.md §6) — the
# newest date-dir under the archive volume (at this 03:17 run, that's the
# previous evening's 21:00-Berlin crawl). Contents are already gzipped, so
# `tar -cf` with NO `-z`. Archiving may be disabled (CALIBER_ARCHIVE_DIR
# unset) or the crawl may not have produced a night's dir yet — either way,
# log and skip; alert-check already pages on crawl failure itself, this is
# not a second failure surface. Local date-dirs are never pruned here
# (retention decision A) — the box itself is the copy of record, this is a
# nightly off-box mirror.
ARCHIVE_DATE_DIR="$(docker compose exec -T app sh -c 'ls -1 /var/lib/caliber/archive 2>/dev/null | sort | tail -1' | tr -d '\r')"
if [ -n "$ARCHIVE_DATE_DIR" ]; then
  docker compose cp "app:/var/lib/caliber/archive/$ARCHIVE_DATE_DIR" "$WORK/archive-$ARCHIVE_DATE_DIR"
  tar -cf "$WORK/archive-$ARCHIVE_DATE_DIR.tar" -C "$WORK" "archive-$ARCHIVE_DATE_DIR"
else
  echo "backup: no archive date-dir found — skipping (archiving disabled or crawl produced none yet)"
fi
```

- [ ] **Step 2: Modify step 4 (encrypt) to also encrypt the archive tar when present**

```bash
# 4. Encrypt to the operator's age public key.
age -r "$AGE_RECIPIENT" -o "$WORK/caliber-$STAMP.db.age" "$WORK/caliber-$STAMP.db"
age -r "$AGE_RECIPIENT" -o "$WORK/uploads-$STAMP.tar.gz.age" "$WORK/uploads-$STAMP.tar.gz"
if [ -n "$ARCHIVE_DATE_DIR" ]; then
  age -r "$AGE_RECIPIENT" -o "$WORK/archive-$ARCHIVE_DATE_DIR.tar.age" "$WORK/archive-$ARCHIVE_DATE_DIR.tar"
fi
```

- [ ] **Step 3: Modify step 5 (off-box) to also copy the archive leg when present**

```bash
# 5. Off-box.
rclone copyto "$WORK/caliber-$STAMP.db.age" "$RCLONE_REMOTE/db/caliber-$STAMP.db.age"
rclone copyto "$WORK/uploads-$STAMP.tar.gz.age" "$RCLONE_REMOTE/uploads/uploads-$STAMP.tar.gz.age"
if [ -n "$ARCHIVE_DATE_DIR" ]; then
  rclone copyto "$WORK/archive-$ARCHIVE_DATE_DIR.tar.age" "$RCLONE_REMOTE/archive/archive-$ARCHIVE_DATE_DIR.tar.age"
fi
```

- [ ] **Step 4: Verify shell syntax**

Run: `bash -n scripts/backup.sh`
Expected: no output, exit code 0 — the script parses. (Full pipeline verification — `docker compose exec`/`cp` against a real archive volume — is an ops step deferred to deploy, per spec §7: "Ops: `backup.sh` change verified by a manual dry-run on the box at deploy time.")

- [ ] **Step 5: Commit**

```bash
git add scripts/backup.sh
git commit -m "$(cat <<'EOF'
feat(archive): backup.sh copies the newest archive date-dir off-box, encrypted

Claude-Session: https://claude.ai/code/session_01GLFjNNLAhkC74ZX5dMzKFT
EOF
)"
```
