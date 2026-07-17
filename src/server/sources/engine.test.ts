// Task 0.3 gate — the engine must be trustworthy BEFORE it touches the network
// for 90 minutes. Everything here runs against fixtures with an injected fetch;
// the engine never touches the global fetch or a real DB.
//
// The fixture scenario is engineered so identity produces both verdicts on real-
// shaped data: five candidates, three that confirm (Vercel/Ramp/G2), two that
// MISMATCH via the exact mis-attributions identity.ts exists to catch
// (lever "porter" = "Porter Cares, Inc." vs YC Porter; greenhouse "affinity" =
// "Affinity.co" vs YC Affinity). Only the three confirmed survive to validate.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, renderReport, runEngine, type EngineReport, type SourcesWriter } from "./engine";
import type { FetchLike } from "./validate";

// ---------------------------------------------------------------------------
// Real dataset endpoints (must stay in lock-step with engine.ts)
// ---------------------------------------------------------------------------
const JOBHIVE_DIR = "https://api.github.com/repos/kalil0321/ats-scrapers/contents/ats-companies";
const REMOTEINTECH_DIR = "https://api.github.com/repos/remoteintech/remote-jobs/contents/src/companies";
const YC_OSS = "https://yc-oss.github.io/api/companies/all.json";
const RAW = "https://raw.test/";

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function text(body: string, status = 200): Response {
  return new Response(body, { status });
}
const ghIdentity = (name: string) => () => json({ name, content: "" });
const leverIdentity = (title: string) => () => text(`<html><head><title>${title} </title></head></html>`);
const ashbyIdentity = (name: string, website: string) => () =>
  text(`<script>window.__data={"organization":{"organizationId":"o1","name":"${name}","publicWebsite":"${website}"}};</script>`);
const ghJobs = (n: number) => () => json({ jobs: Array.from({ length: n }, (_, i) => ({ id: i })) });
const leverJobs = (n: number) => () => json(Array.from({ length: n }, (_, i) => ({ id: i })));
const ashbyJobs = (n: number) => () => json({ jobs: Array.from({ length: n }, (_, i) => ({ id: i })) });
const status = (code: number) => () => text("", code);
const malformedGh = () => json({}); // 200 with no `jobs` array -> jobCountFor throws -> a crash
const reject = () => {
  throw new Error("ECONNRESET");
};

// ---------------------------------------------------------------------------
// Injected fetch router
// ---------------------------------------------------------------------------
interface FetchSpec {
  jobhive: string;
  ycOss: unknown;
  remote?: { name: string; content: string }[];
  identity: Record<string, () => Response>;
  validate: Record<string, () => Response>;
  ycOssStatus?: number;
  /** Extra non-ATS vendor CSVs (avature.csv, workable.csv, …) to list alongside the three real files — must never be fetched. */
  jobhiveExtraFiles?: string[];
  /** Allowlisted jobhive filenames to omit from the directory listing, to exercise the "layout changed" fail-loud. */
  jobhiveOmit?: string[];
}

// The real jobhive layout is one CSV per ATS (§ engine.ts JOBHIVE_ALLOWED_FILES).
// Fixtures write jobhive rows as one mixed `name,slug,url` block for
// readability; this splits it back into per-ats files by URL host so the
// mock directory listing matches reality.
function splitJobhiveByFile(csv: string): Record<string, string> {
  const lines = csv.split("\n");
  const header = lines[0];
  const buckets: Record<string, string[]> = { "greenhouse.csv": [], "lever.csv": [], "ashby.csv": [] };
  for (const line of lines.slice(1)) {
    if (line.trim() === "") continue;
    if (line.includes("greenhouse.io")) buckets["greenhouse.csv"].push(line);
    else if (line.includes("lever.co")) buckets["lever.csv"].push(line);
    else if (line.includes("ashbyhq.com")) buckets["ashby.csv"].push(line);
    else throw new Error(`test: cannot classify jobhive fixture line by ats: ${line}`);
  }
  const files: Record<string, string> = {};
  for (const [name, rows] of Object.entries(buckets)) files[name] = [header, ...rows, ""].join("\n");
  return files;
}

function keyFromUrl(url: string): { kind: "identity" | "validate"; key: string } | null {
  let m: RegExpExecArray | null;
  if ((m = /^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/([^/?]+)\/jobs/.exec(url))) return { kind: "validate", key: `greenhouse:${m[1]}` };
  if ((m = /^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/([^/?]+)$/.exec(url))) return { kind: "identity", key: `greenhouse:${m[1]}` };
  if ((m = /^https:\/\/api\.lever\.co\/v0\/postings\/([^/?]+)/.exec(url))) return { kind: "validate", key: `lever:${m[1]}` };
  if ((m = /^https:\/\/jobs\.lever\.co\/([^/?]+)$/.exec(url))) return { kind: "identity", key: `lever:${m[1]}` };
  if ((m = /^https:\/\/api\.ashbyhq\.com\/posting-api\/job-board\/([^/?]+)/.exec(url))) return { kind: "validate", key: `ashby:${m[1]}` };
  if ((m = /^https:\/\/jobs\.ashbyhq\.com\/([^/?]+)$/.exec(url))) return { kind: "identity", key: `ashby:${m[1]}` };
  return null;
}

function buildFetch(spec: FetchSpec): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const remote = spec.remote ?? [{ name: "gitlab.md", content: GITLAB_MD }];
  const fetch: FetchLike = async (input) => {
    const url = String(input);
    calls.push(url);

    if (url === JOBHIVE_DIR) {
      const omit = new Set(spec.jobhiveOmit ?? []);
      const real = Object.keys(splitJobhiveByFile(spec.jobhive))
        .filter((name) => !omit.has(name))
        .map((name) => ({ name, type: "file", download_url: `${RAW}jobhive/${name}` }));
      const extra = (spec.jobhiveExtraFiles ?? []).map((name) => ({
        name,
        type: "file",
        download_url: `${RAW}jobhive/vendor/${name}`,
      }));
      return json([...real, ...extra]);
    }
    if (url.startsWith(`${RAW}jobhive/`) && !url.startsWith(`${RAW}jobhive/vendor/`)) {
      const name = url.slice(`${RAW}jobhive/`.length);
      const files = splitJobhiveByFile(spec.jobhive);
      return text(files[name]);
    }
    if (url === YC_OSS) return spec.ycOssStatus && spec.ycOssStatus !== 200 ? status(spec.ycOssStatus)() : json(spec.ycOss);
    if (url === REMOTEINTECH_DIR) return json(remote.map((f) => ({ name: f.name, type: "file", download_url: `${RAW}remote/${f.name}` })));
    if (url.startsWith(`${RAW}remote/`)) {
      const name = url.slice(`${RAW}remote/`.length);
      const file = remote.find((f) => f.name === name);
      if (!file) throw new Error(`test: no remote fixture ${name}`);
      return text(file.content);
    }

    const routed = keyFromUrl(url);
    if (!routed) throw new Error(`test: unrouted url ${url}`);
    const table = routed.kind === "identity" ? spec.identity : spec.validate;
    const responder = table[routed.key];
    if (!responder) throw new Error(`test: no ${routed.kind} responder for ${routed.key}`);
    return responder();
  };
  return { fetch, calls };
}

// ---------------------------------------------------------------------------
// Base 5-candidate scenario
// ---------------------------------------------------------------------------
const BASE_JOBHIVE = [
  "name,slug,url",
  "Vercel,vercel,https://boards.greenhouse.io/vercel",
  "Ramp,ramp,https://jobs.lever.co/ramp",
  "G2,g2,https://jobs.ashbyhq.com/g2",
  '"Porter Cares, Inc.",porter,https://jobs.lever.co/porter',
  "Affinity.co,affinity,https://boards.greenhouse.io/affinity",
  "",
].join("\n");

const BASE_YC = [
  { name: "Vercel", website: "https://vercel.com", isHiring: true },
  { name: "Ramp", website: "https://ramp.com", isHiring: true },
  { name: "G2", website: "https://g2.com", isHiring: true },
  { name: "Porter", website: "https://porter.run", isHiring: true },
  { name: "Affinity", website: "https://itsaffinity.com", isHiring: false },
];

const GITLAB_MD = [
  "---",
  'title: "GitLab"',
  "website: https://about.gitlab.com/",
  "careers_url: https://about.gitlab.com/jobs/",
  "---",
  "# GitLab",
].join("\n");

function baseSpec(overrides: Partial<FetchSpec> = {}): FetchSpec {
  return {
    jobhive: BASE_JOBHIVE,
    ycOss: BASE_YC,
    remote: [{ name: "gitlab.md", content: GITLAB_MD }],
    identity: {
      "greenhouse:vercel": ghIdentity("Vercel"),
      "lever:ramp": leverIdentity("Ramp"),
      "ashby:g2": ashbyIdentity("G2", "https://g2.com/"),
      "lever:porter": leverIdentity("Porter Cares, Inc."),
      "greenhouse:affinity": ghIdentity("Affinity.co"),
    },
    validate: {
      "greenhouse:vercel": ghJobs(10),
      "lever:ramp": leverJobs(5),
      "ashby:g2": ashbyJobs(3),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Temp paths + repo spy
// ---------------------------------------------------------------------------
let dirs: string[] = [];
async function tmpPaths(): Promise<{ reportPath: string; checkpointPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "caliber-engine-"));
  dirs.push(dir);
  return { reportPath: join(dir, "report.md"), checkpointPath: join(dir, "checkpoint.jsonl") };
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

function spyRepo(): SourcesWriter & { bulkInsert: ReturnType<typeof vi.fn> } {
  const bulkInsert = vi.fn(async (rows: unknown[]) => rows);
  return { bulkInsert };
}

const COMMON = { now: () => 1_752_700_000_000, identityDelayMs: 0, log: () => {} };

async function run(spec: FetchSpec, opts: Partial<Parameters<typeof runEngine>[0]> = {}): Promise<{ report: EngineReport; calls: string[]; repo: ReturnType<typeof spyRepo> }> {
  const { fetch, calls } = buildFetch(spec);
  const paths = await tmpPaths();
  const repo = spyRepo();
  const report = await runEngine({ fetch, sourcesRepo: repo, ...paths, ...COMMON, ...opts });
  return { report, calls, repo };
}

// ===========================================================================

describe("runEngine — chain end to end (fixtures + injected fetch)", () => {
  it("ingests, matches, gates on identity, validates, and projects a seed count", async () => {
    const { report, repo } = await run(baseSpec());

    expect(report.jobhiveRows).toBe(5);
    expect(report.jobhiveByAts).toEqual({ greenhouse: 2, lever: 2, ashby: 1 });
    expect(report.ycOssCompanies).toBe(5); // Affinity kept; none dropped for a bad domain here
    expect(report.remoteInTechCompanies).toBe(1);

    expect(report.candidates).toBe(5);
    expect(report.identity).toEqual({ confirmed: 3, mismatch: 2, unverifiable: 0, skippedHostStopped: 0 });
    expect(report.validated.live).toBe(3);
    expect(report.liveJobCount).toBe(18);
    expect(report.seedable).toBe(3);

    // dry run is the default — zero DB writes
    expect(repo.bulkInsert).not.toHaveBeenCalled();
    expect(report.seeded).toBe(false);
    expect(report.rowsWritten).toBe(0);
  });

  it("reports the real mismatches — the most interesting output", async () => {
    const { report } = await run(baseSpec());
    expect(report.mismatchSamples).toHaveLength(2);
    expect(report.mismatchSamples.join("\n")).toContain("Porter Cares, Inc.");
    expect(report.mismatchSamples.join("\n")).toContain("Affinity.co");
  });

  it("writes a human-readable markdown report with the real counts", async () => {
    const { fetch } = buildFetch(baseSpec());
    const paths = await tmpPaths();
    await runEngine({ fetch, sourcesRepo: spyRepo(), ...paths, ...COMMON });
    const md = await readFile(paths.reportPath, "utf8");
    expect(md).toContain("# Source engine — dry run");
    expect(md).toContain("Rows ingested: **5**");
    expect(md).toContain("Candidates: **5**");
    expect(md).toContain("Porter Cares, Inc.");
  });
});

describe("runEngine — jobhive allowlist (only greenhouse/lever/ashby CSVs are ingested)", () => {
  it("skips non-allowlisted vendor CSVs in the directory listing without fetching or parsing them", async () => {
    // The real ats-companies/ directory has 27 ATS CSVs, not 3. avature.csv
    // rows fail the greenhouse/lever/ashby URL signatures in parseJobhiveCsv
    // by design — the engine must never hand it that file.
    const { report, calls } = await run(
      baseSpec({ jobhiveExtraFiles: ["avature.csv", "workable.csv", "bamboohr.csv"] }),
    );

    // only the three allowlisted files were fetched and parsed
    expect(report.jobhiveFiles.slice().sort()).toEqual(["ashby.csv", "greenhouse.csv", "lever.csv"]);
    expect(report.jobhiveRows).toBe(5);
    expect(report.candidates).toBe(5);

    // the extras were never fetched at all
    expect(calls.some((u) => u.includes("avature.csv"))).toBe(false);
    expect(calls.some((u) => u.includes("workable.csv"))).toBe(false);
    expect(calls.some((u) => u.includes("bamboohr.csv"))).toBe(false);
    expect(calls.some((u) => u.startsWith(`${RAW}jobhive/vendor/`))).toBe(false);

    // the run completes normally — no crash from an unrecognized ATS host
    expect(report.identity.confirmed).toBe(3);
  });

  it("fails loud when an allowlisted file is missing from the directory listing", async () => {
    const { fetch } = buildFetch(baseSpec({ jobhiveOmit: ["lever.csv"] }));
    const paths = await tmpPaths();
    await expect(runEngine({ fetch, sourcesRepo: spyRepo(), ...paths, ...COMMON })).rejects.toThrow(
      /missing allowlisted file\(s\) lever\.csv/,
    );
  });
});

describe("runEngine — seeding", () => {
  it("--seed writes ONLY identity-confirmed AND validated rows", async () => {
    const { report, repo } = await run(baseSpec(), { seed: true });

    expect(repo.bulkInsert).toHaveBeenCalledTimes(1);
    const rows = repo.bulkInsert.mock.calls[0][0] as { id: string }[];
    expect(rows.map((r) => r.id).sort()).toEqual(["ashby:g2", "gh:vercel", "lever:ramp"]);
    // porter + affinity mismatched — never seeded, even though they matched
    expect(rows.map((r) => r.id)).not.toContain("lever:porter");
    expect(rows.map((r) => r.id)).not.toContain("gh:affinity");
    expect(report.rowsWritten).toBe(3);
  });

  it("a confirmed candidate that fails validation (404) is not seeded", async () => {
    const spec = baseSpec({ validate: { "greenhouse:vercel": ghJobs(10), "lever:ramp": status(404), "ashby:g2": ashbyJobs(3) } });
    const { report, repo } = await run(spec, { seed: true });

    const rows = repo.bulkInsert.mock.calls[0][0] as { id: string }[];
    expect(rows.map((r) => r.id).sort()).toEqual(["ashby:g2", "gh:vercel"]);
    expect(report.validated.notFound).toBe(1);
    expect(report.seedable).toBe(2);
  });
});

describe("runEngine — politeness (403/429 is a stop signal, never routed around)", () => {
  it("a 403 mid-run stops that host but the pass completes and other hosts continue", async () => {
    const jobhive = [
      "name,slug,url",
      "Alpha,alpha,https://boards.greenhouse.io/alpha",
      "Bravo,bravo,https://boards.greenhouse.io/bravo",
      "Ramp,ramp,https://jobs.lever.co/ramp",
      "",
    ].join("\n");
    const spec: FetchSpec = {
      jobhive,
      ycOss: [
        { name: "Alpha", website: "https://alpha.com", isHiring: true },
        { name: "Bravo", website: "https://bravo.com", isHiring: true },
        { name: "Ramp", website: "https://ramp.com", isHiring: true },
      ],
      identity: {
        "greenhouse:alpha": ghIdentity("Alpha"),
        "greenhouse:bravo": ghIdentity("Bravo"),
        "lever:ramp": leverIdentity("Ramp"),
      },
      validate: {
        "greenhouse:alpha": status(403),
        "greenhouse:bravo": ghJobs(7), // must never be reached
        "lever:ramp": leverJobs(4),
      },
    };

    const { report, calls } = await run(spec, { chunkSize: 1 });

    expect(report.hostStops).toEqual([
      { stage: "validate", host: "boards-api.greenhouse.io", reason: "forbidden", triggeredBy: "greenhouse:alpha" },
    ]);
    // bravo shares the stopped host — never validated
    expect(calls.some((u) => u.includes("/v1/boards/bravo/jobs"))).toBe(false);
    expect(report.validated.skippedHostStopped).toBe(1);
    // the other host still yielded
    expect(report.validated.live).toBe(1);
    expect(report.seedable).toBe(1);
  });
});

describe("runEngine — a network error mid-run does not discard completed results", () => {
  it("tallies the network error and still seeds the sibling that succeeded", async () => {
    const jobhive = [
      "name,slug,url",
      "Ramp,ramp,https://jobs.lever.co/ramp",
      "Toptal,toptal,https://jobs.lever.co/toptal",
      "",
    ].join("\n");
    const spec: FetchSpec = {
      jobhive,
      ycOss: [
        { name: "Ramp", website: "https://ramp.com", isHiring: true },
        { name: "Toptal", website: "https://toptal.com", isHiring: true },
      ],
      identity: { "lever:ramp": leverIdentity("Ramp"), "lever:toptal": leverIdentity("Toptal") },
      validate: { "lever:ramp": reject, "lever:toptal": leverJobs(9) },
    };

    const { report } = await run(spec);

    expect(report.validated.networkError).toBe(1);
    expect(report.validated.live).toBe(1);
    expect(report.seedable).toBe(1);
    // a network error is NOT a stop signal
    expect(report.hostStops).toEqual([]);
  });
});

describe("runEngine — resumability", () => {
  it("resumes from the checkpoint after a crash, with no duplicate work", async () => {
    const jobhive = [
      "name,slug,url",
      "Alpha,alpha,https://boards.greenhouse.io/alpha",
      "Bravo,bravo,https://boards.greenhouse.io/bravo",
      "Charlie,charlie,https://boards.greenhouse.io/charlie",
      "",
    ].join("\n");
    const ycOss = [
      { name: "Alpha", website: "https://alpha.com", isHiring: true },
      { name: "Bravo", website: "https://bravo.com", isHiring: true },
      { name: "Charlie", website: "https://charlie.com", isHiring: true },
    ];
    const identity = {
      "greenhouse:alpha": ghIdentity("Alpha"),
      "greenhouse:bravo": ghIdentity("Bravo"),
      "greenhouse:charlie": ghIdentity("Charlie"),
    };
    const paths = await tmpPaths();

    // Run 1: alpha validates ok (checkpointed), bravo returns a malformed 200
    // that throws inside validation -> the run crashes mid-validate.
    const crash = buildFetch({
      jobhive,
      ycOss,
      identity,
      validate: { "greenhouse:alpha": ghJobs(3), "greenhouse:bravo": malformedGh, "greenhouse:charlie": ghJobs(3) },
    });
    await expect(
      runEngine({ fetch: crash.fetch, sourcesRepo: spyRepo(), ...paths, ...COMMON, chunkSize: 1 }),
    ).rejects.toThrow();

    // Run 2: everything healthy. Resume must skip already-done identity + the
    // one validated slug, and only validate the two that never completed.
    const resume = buildFetch({
      jobhive,
      ycOss,
      identity,
      validate: { "greenhouse:alpha": ghJobs(3), "greenhouse:bravo": ghJobs(3), "greenhouse:charlie": ghJobs(3) },
    });
    const repo = spyRepo();
    const report = await runEngine({ fetch: resume.fetch, sourcesRepo: repo, ...paths, ...COMMON, chunkSize: 1, seed: true });

    // no re-fetch of completed identity work
    expect(resume.calls.some((u) => u.endsWith("/v1/boards/alpha"))).toBe(false);
    expect(resume.calls.some((u) => u.endsWith("/v1/boards/bravo"))).toBe(false);
    expect(resume.calls.some((u) => u.endsWith("/v1/boards/charlie"))).toBe(false);
    // alpha validation already done in run 1 — not repeated
    expect(resume.calls.some((u) => u.includes("/v1/boards/alpha/jobs"))).toBe(false);
    // the two unfinished slugs ARE validated on resume
    expect(resume.calls.some((u) => u.includes("/v1/boards/bravo/jobs"))).toBe(true);
    expect(resume.calls.some((u) => u.includes("/v1/boards/charlie/jobs"))).toBe(true);

    expect(report.validated.live).toBe(3);
    expect(report.seedable).toBe(3);
    expect(repo.bulkInsert).toHaveBeenCalledTimes(1);
  });

  it("fails loud if the checkpoint was written for a different candidate set", async () => {
    const paths = await tmpPaths();
    // Seed a checkpoint from a 2-candidate run.
    const first = buildFetch({
      jobhive: ["name,slug,url", "Ramp,ramp,https://jobs.lever.co/ramp", ""].join("\n"),
      ycOss: [{ name: "Ramp", website: "https://ramp.com", isHiring: true }],
      identity: { "lever:ramp": leverIdentity("Ramp") },
      validate: { "lever:ramp": leverJobs(1) },
    });
    await runEngine({ fetch: first.fetch, sourcesRepo: spyRepo(), ...paths, ...COMMON });

    // Re-run with a DIFFERENT candidate set against the same checkpoint.
    const second = buildFetch(baseSpec());
    await expect(
      runEngine({ fetch: second.fetch, sourcesRepo: spyRepo(), ...paths, ...COMMON }),
    ).rejects.toThrow(/different candidate set|upstream lists changed/);
  });
});

describe("runEngine — dataset fetch fails loud (D8: no stale-cache fallback)", () => {
  it("a yc-oss fetch failure aborts the run and writes nothing", async () => {
    const repo = spyRepo();
    const { fetch } = buildFetch(baseSpec({ ycOssStatus: 500 }));
    const paths = await tmpPaths();
    await expect(runEngine({ fetch, sourcesRepo: repo, ...paths, ...COMMON })).rejects.toThrow(/HTTP 500|yc-oss|companies\/all\.json/);
    expect(repo.bulkInsert).not.toHaveBeenCalled();
  });
});

describe("parseArgs — CLI surface", () => {
  it("defaults to a dry run", () => {
    expect(parseArgs([])).toEqual({
      seed: false,
      reportPath: "docs/superpowers/reports/2026-07-17-engine-dry-run.md",
      checkpointPath: ".cache/sources-engine-checkpoint.jsonl",
    });
  });
  it("--seed opts in to writing", () => {
    expect(parseArgs(["--seed"]).seed).toBe(true);
  });
  it("--dry-run is accepted (and is the same as the default)", () => {
    expect(parseArgs(["--dry-run"]).seed).toBe(false);
  });
  it("rejects --dry-run and --seed together", () => {
    expect(() => parseArgs(["--dry-run", "--seed"])).toThrow(/contradictory/);
  });
  it("takes --report= and --checkpoint= overrides", () => {
    const cli = parseArgs(["--report=/tmp/r.md", "--checkpoint=/tmp/c.jsonl"]);
    expect(cli.reportPath).toBe("/tmp/r.md");
    expect(cli.checkpointPath).toBe("/tmp/c.jsonl");
  });
  it("fails loud on an unknown flag", () => {
    expect(() => parseArgs(["--wat"])).toThrow(/unknown argument/);
  });
});

describe("renderReport — shape", () => {
  it("names a seed run distinctly from a dry run", () => {
    const base: EngineReport = {
      seeded: true,
      startedAt: 0,
      finishedAt: 60000,
      jobhiveFiles: ["companies.csv"],
      jobhiveRows: 5,
      jobhiveByAts: { greenhouse: 2 },
      ycOssCompanies: 5,
      remoteInTechCompanies: 1,
      candidates: 5,
      candidatesByAts: { greenhouse: 2 },
      candidatesByMatchMethod: { "domain-stem": 4, name: 1 },
      candidatesByProvenance: { "yc-oss": 5 },
      identity: { confirmed: 3, mismatch: 2, unverifiable: 0, skippedHostStopped: 0 },
      identityByAts: { greenhouse: { confirmed: 1, mismatch: 1, unverifiable: 0 } },
      unverifiableReasons: {},
      mismatchSamples: ["x reports Y"],
      validated: { live: 3, notFound: 0, otherHttp: 0, networkError: 0, skippedHostStopped: 0 },
      validatedByAts: { greenhouse: { live: 1, notOk: 0 } },
      liveJobCount: 18,
      seedable: 3,
      rowsWritten: 3,
      hostStops: [],
    };
    expect(renderReport(base)).toContain("# Source engine — SEED run");
    expect(renderReport(base)).toContain("rows written");
  });
});
