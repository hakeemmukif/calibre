import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSourcesRepo } from "../persistence/repos/sources";
import { createTestDb } from "../persistence/test-db";
import { parseArgs, runFreshnessCli } from "./freshness-run";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function engineConfig(overrides: Record<string, unknown> = {}) {
  return {
    connector: "lever",
    slug: "acme",
    provenance: ["jobhive"],
    companyDomain: "acme.com",
    lastValidatedAt: 1_000,
    jobCount: 5,
    consecutiveFailures: 0,
    status: "active",
    ...overrides,
  };
}

let dirs: string[] = [];
async function tmpReportPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "caliber-freshness-run-"));
  dirs.push(dir);
  return join(dir, "report.md");
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

describe("runFreshnessCli", () => {
  it("invokes runFreshnessPass, writes a run summary, and exits 0 on a clean pass", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);
    await repo.insert({
      id: "lever:acme",
      name: "Acme",
      kind: "ats",
      persona: "remote",
      enabled: true,
      config: engineConfig(),
    });

    const fetchMock = vi.fn(async () => jsonResponse(200, [{ id: "a" }]));
    const reportPath = await tmpReportPath();
    const logs: string[] = [];

    const result = await runFreshnessCli({
      repo,
      fetch: fetchMock,
      now: () => 2_000,
      reportPath,
      log: (m) => logs.push(m),
    });

    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toEqual([{ id: "lever:acme", action: "revalidated_ok", jobCount: 1 }]);
    expect(fetchMock).toHaveBeenCalled();

    const combinedLog = logs.join("\n");
    expect(combinedLog).toContain("revalidated_ok");

    const written = await readFile(reportPath, "utf8");
    expect(written).toContain("revalidated_ok");
    expect(written).toContain("# Freshness run — OK");
  });

  // THE regression that matters: FreshnessPassError carries the outcomes of
  // every row that DID process before the corrupt one was hit. A plain
  // `.catch(console.error)` would print the stack and lose that summary.
  it("catches FreshnessPassError, prints + writes the PARTIAL outcomes (not swallowed), and exits non-zero", async () => {
    const db = await createTestDb();
    const repo = createSourcesRepo(db);
    await repo.insert({
      id: "lever:good",
      name: "Good",
      kind: "ats",
      persona: "remote",
      enabled: true,
      config: engineConfig({ slug: "good" }),
    });
    await repo.insert({
      id: "lever:corrupt",
      name: "Corrupt",
      kind: "ats",
      persona: "remote",
      enabled: true,
      config: engineConfig({ slug: "corrupt", consecutiveFailures: "three" }),
    });

    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://api.lever.co/v0/postings/good") return jsonResponse(200, [{ id: "a" }]);
      throw new Error(`unexpected url ${url}`);
    });
    const reportPath = await tmpReportPath();
    const logs: string[] = [];

    const result = await runFreshnessCli({
      repo,
      fetch: fetchMock,
      now: () => 2_000,
      reportPath,
      log: (m) => logs.push(m),
    });

    expect(result.exitCode).toBe(1);
    // listAll() orders by name ("Corrupt" < "Good"), so the corrupt row's
    // config_malformed outcome lands first, then the good row's real result —
    // both present, neither discarded by the throw.
    expect(result.outcomes).toEqual([
      { id: "lever:corrupt", action: "config_malformed", message: expect.stringMatching(/consecutiveFailures/) },
      { id: "lever:good", action: "revalidated_ok", jobCount: 1 },
    ]);

    const combinedLog = logs.join("\n");
    expect(combinedLog).toContain("revalidated_ok");
    expect(combinedLog).toContain("lever:corrupt");
    expect(combinedLog).toContain("consecutiveFailures");

    const written = await readFile(reportPath, "utf8");
    expect(written).toContain("# Freshness run — PARTIAL");
    expect(written).toContain("revalidated_ok");
    expect(written).toContain("lever:corrupt");
    expect(written).toContain("consecutiveFailures");
  });
});

describe("parseArgs — CLI surface", () => {
  it("defaults reportPath when no args given", () => {
    expect(parseArgs([])).toEqual({ reportPath: expect.stringContaining("freshness") });
  });

  it("accepts --report=<path>", () => {
    expect(parseArgs(["--report=/tmp/r.md"]).reportPath).toBe("/tmp/r.md");
  });

  it("throws on an unknown argument", () => {
    expect(() => parseArgs(["--wat"])).toThrow(/unknown argument/);
  });
});
