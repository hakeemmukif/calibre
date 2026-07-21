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
