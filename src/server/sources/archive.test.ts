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

  // rmSync is synchronous and createWriteStream defers its fs.open to a
  // later tick, so this always wins the race — a deterministic ENOENT on the
  // stream's 'error' event, verified (not flaky) via a tsx standalone drive
  // on darwin before being written into this plan.
  it("close() resolves even when the postings sink stream has errored", async () => {
    mkdirSync(join(root, "2026-07-21"), { recursive: true });
    const writer = startArchiveRun(root, "2026-07-21");
    writer.appendPosting({ runDate: "2026-07-21", sourceId: "src1", canonicalKey: "ck-1", posting: {} });
    // Destroy the sink out from under the writer to simulate a mid-run I/O error.
    rmSync(join(root, "2026-07-21"), { recursive: true, force: true });
    await expect(writer.close()).resolves.toBeUndefined();
  });
});
