// Task O.3 gate — sources:growth runs ONLY the yc-oss daily diff (`added[]`)
// through match -> identity -> validate -> seed, never the full 6,050-row
// `companies/all.json`. Everything here runs against fixtures with an
// injected fetch; the module never touches the global fetch or a real DB.
import { describe, expect, it, vi } from "vitest";
import { runGrowth, type GrowthSourcesWriter } from "./growth";
import type { FetchLike } from "./validate";

// ---------------------------------------------------------------------------
// Real dataset endpoints (must stay in lock-step with growth.ts / engine.ts)
// ---------------------------------------------------------------------------
const JOBHIVE_DIR = "https://api.github.com/repos/kalil0321/ats-scrapers/contents/ats-companies";
const YC_OSS_ALL = "https://yc-oss.github.io/api/companies/all.json";
const YC_OSS_CHANGES = "https://yc-oss.github.io/api/changes/latest.json";
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
const statusResp = (code: number) => () => text("", code);

// Mirrors engine.test.ts's splitter: fixtures write jobhive as one mixed
// `name,slug,url` block; the real layout is one CSV per ATS, so this splits
// by URL host to match the mocked directory listing.
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

interface FetchSpec {
  jobhive: string;
  added: unknown[];
  identity?: Record<string, () => Response | Promise<Response>>;
  validate?: Record<string, () => Response | Promise<Response>>;
}

function buildFetch(spec: FetchSpec): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (input) => {
    const url = String(input);
    calls.push(url);

    if (url === YC_OSS_ALL) {
      // The whole point of growth.ts is to never fetch the 6,050-row full
      // list — a fixture that hits this is a bug in growth.ts, not the test.
      throw new Error("test: growth.ts must never fetch yc-oss all.json");
    }
    if (url === YC_OSS_CHANGES) return json({ generated_at: "2026-07-17T00:00:00Z", summary: { added: spec.added.length }, added: spec.added, removed: [], updated: [] });

    if (url === JOBHIVE_DIR) {
      const files = Object.keys(splitJobhiveByFile(spec.jobhive)).map((name) => ({
        name,
        type: "file",
        download_url: `${RAW}jobhive/${name}`,
      }));
      return json(files);
    }
    if (url.startsWith(`${RAW}jobhive/`)) {
      const name = url.slice(`${RAW}jobhive/`.length);
      return text(splitJobhiveByFile(spec.jobhive)[name]);
    }

    const routed = keyFromUrl(url);
    if (!routed) throw new Error(`test: unrouted url ${url}`);
    const table = routed.kind === "identity" ? (spec.identity ?? {}) : (spec.validate ?? {});
    const responder = table[routed.key];
    if (!responder) throw new Error(`test: no ${routed.kind} responder for ${routed.key}`);
    return responder();
  };
  return { fetch, calls };
}

function spyRepo(existingIds: string[] = []): GrowthSourcesWriter & { bulkInsert: ReturnType<typeof vi.fn>; listAll: ReturnType<typeof vi.fn> } {
  const bulkInsert = vi.fn(async (rows: unknown[]) => rows);
  const listAll = vi.fn(async () => existingIds.map((id) => ({ id })));
  return { bulkInsert, listAll };
}

const COMMON = { now: () => 1_752_700_000_000, identityDelayMs: 0, log: () => {} };

// ---------------------------------------------------------------------------
// Base scenario: 3 companies in the diff.
//   Vercel  -> confirms, validates live -> seeded
//   Porter  -> matches lever "Porter Cares, Inc." -> identity MISMATCH -> dropped
//   Toptal  -> matches, but "lever:toptal" is already a seeded id -> skipped
//              before identity/validate ever run
// ---------------------------------------------------------------------------
const BASE_JOBHIVE = [
  "name,slug,url",
  "Vercel,vercel,https://boards.greenhouse.io/vercel",
  '"Porter Cares, Inc.",porter,https://jobs.lever.co/porter',
  "Toptal,toptal,https://jobs.lever.co/toptal",
  "",
].join("\n");

const BASE_ADDED = [
  { name: "Vercel", website: "https://vercel.com", isHiring: true },
  { name: "Porter", website: "https://porter.run", isHiring: true },
  { name: "Toptal", website: "https://toptal.com", isHiring: true },
];

const BASE_IDENTITY = {
  "greenhouse:vercel": ghIdentity("Vercel"),
  "lever:porter": leverIdentity("Porter Cares, Inc."),
};
const BASE_VALIDATE = {
  "greenhouse:vercel": ghJobs(10),
};

describe("runGrowth — chain end to end (fixtures + injected fetch)", () => {
  it("matches only the diff, dedupes already-seeded ids, and seeds confirmed+validated rows", async () => {
    const { fetch, calls } = buildFetch({ jobhive: BASE_JOBHIVE, added: BASE_ADDED, identity: BASE_IDENTITY, validate: BASE_VALIDATE });
    const repo = spyRepo(["lever:toptal"]);

    const report = await runGrowth({ fetch, sourcesRepo: repo, ...COMMON });

    expect(report.added).toBe(3);
    expect(report.matched).toBe(3);
    expect(report.skippedAlreadySeeded).toBe(1);
    expect(report.identityConfirmed).toBe(1); // vercel
    expect(report.identityDropped).toBe(1); // porter mismatch
    expect(report.validatedLive).toBe(1);
    expect(report.seeded).toBe(1);

    // all.json is never fetched
    expect(calls).not.toContain(YC_OSS_ALL);
    // the diff endpoint and jobhive ARE fetched
    expect(calls).toContain(YC_OSS_CHANGES);
    expect(calls).toContain(JOBHIVE_DIR);
    expect(calls.some((u) => u.endsWith("jobhive/greenhouse.csv"))).toBe(true);

    // toptal (already seeded) never hit identity or validate
    expect(calls.some((u) => u.endsWith("jobs.lever.co/toptal"))).toBe(false);
    expect(calls.some((u) => u.includes("/v0/postings/toptal"))).toBe(false);

    // only the confirmed+validated row seeded
    expect(repo.bulkInsert).toHaveBeenCalledTimes(1);
    const rows = repo.bulkInsert.mock.calls[0][0] as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(["gh:vercel"]);
    expect(repo.listAll).toHaveBeenCalledTimes(1);
  });

  it("an empty diff is a clean no-op (jobhive is still fetched — not optional)", async () => {
    const { fetch, calls } = buildFetch({ jobhive: BASE_JOBHIVE, added: [] });
    const repo = spyRepo();

    const report = await runGrowth({ fetch, sourcesRepo: repo, ...COMMON });

    expect(report.added).toBe(0);
    expect(report.matched).toBe(0);
    expect(report.seeded).toBe(0);
    expect(repo.bulkInsert).not.toHaveBeenCalled();
    // jobhive fetched unconditionally even though there was nothing to match
    expect(calls).toContain(JOBHIVE_DIR);
    expect(calls).not.toContain(YC_OSS_ALL);
  });
});

describe("runGrowth — politeness (any 403/429 aborts the whole pass, fail loud)", () => {
  it("a 403 on identity aborts loudly before any seed write", async () => {
    const { fetch } = buildFetch({
      jobhive: BASE_JOBHIVE,
      added: BASE_ADDED,
      identity: { "greenhouse:vercel": statusResp(403), "lever:porter": leverIdentity("Porter Cares, Inc.") },
      validate: BASE_VALIDATE,
    });
    const repo = spyRepo(["lever:toptal"]);

    await expect(runGrowth({ fetch, sourcesRepo: repo, ...COMMON })).rejects.toThrow(/forbidden/);
    expect(repo.bulkInsert).not.toHaveBeenCalled();
  });

  it("a 429 on validate aborts loudly before any seed write", async () => {
    const { fetch } = buildFetch({
      jobhive: BASE_JOBHIVE,
      added: BASE_ADDED,
      identity: BASE_IDENTITY,
      validate: { "greenhouse:vercel": statusResp(429) },
    });
    const repo = spyRepo(["lever:toptal"]);

    await expect(runGrowth({ fetch, sourcesRepo: repo, ...COMMON })).rejects.toThrow(/429|rate_limited/);
    expect(repo.bulkInsert).not.toHaveBeenCalled();
  });
});

describe("runGrowth — dataset fetch fails loud", () => {
  it("a non-200 from the changes endpoint aborts the run", async () => {
    const { fetch } = buildFetch({ jobhive: BASE_JOBHIVE, added: BASE_ADDED });
    const wrapped: FetchLike = async (url, init) => {
      if (String(url) === YC_OSS_CHANGES) return text("", 500);
      return fetch(url, init);
    };
    const repo = spyRepo();
    await expect(runGrowth({ fetch: wrapped, sourcesRepo: repo, ...COMMON })).rejects.toThrow(/HTTP 500|changes\/latest\.json/);
    expect(repo.bulkInsert).not.toHaveBeenCalled();
  });

  it("a malformed changes payload (no added[]) aborts the run", async () => {
    const wrapped: FetchLike = async (url) => {
      if (String(url) === YC_OSS_CHANGES) return json({ generated_at: "x", summary: {} });
      throw new Error(`test: unexpected url ${String(url)}`);
    };
    const repo = spyRepo();
    await expect(runGrowth({ fetch: wrapped, sourcesRepo: repo, ...COMMON })).rejects.toThrow(/expected.*added/);
    expect(repo.bulkInsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// S1 — batch-day meltdown guard: a diff this large is a YC batch drop, which
// belongs to the full idempotent `sources:engine --seed`, not this daily path.
// ---------------------------------------------------------------------------
describe("runGrowth — GROWTH_MAX_FRESH batch cap", () => {
  it("a fresh batch of >25 companies aborts loudly and never touches identity or seed", async () => {
    const n = 30;
    const jobhiveRows = Array.from({ length: n }, (_, i) => `Company${i},company${i},https://boards.greenhouse.io/company${i}`);
    const jobhive = ["name,slug,url", ...jobhiveRows, ""].join("\n");
    const added = Array.from({ length: n }, (_, i) => ({ name: `Company${i}`, website: `https://company${i}.com`, isHiring: true }));

    const { fetch, calls } = buildFetch({ jobhive, added });
    const repo = spyRepo();

    await expect(runGrowth({ fetch, sourcesRepo: repo, ...COMMON })).rejects.toThrow(/30 fresh|sources:engine/);
    expect(repo.bulkInsert).not.toHaveBeenCalled();

    // no identity or validate request was ever made — the cap check runs
    // before either stage
    const allowed = new Set([YC_OSS_CHANGES, JOBHIVE_DIR]);
    expect(calls.every((u) => allowed.has(u) || u.startsWith(`${RAW}jobhive/`))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// S1 — identity pacing: verifyIdentity's politeness delay only paces calls
// that await one another. A bare Promise.all fires them all at once.
// ---------------------------------------------------------------------------
describe("runGrowth — identity checks are paced sequentially", () => {
  it("never has more than one identity request in flight at a time", async () => {
    const jobhive = [
      "name,slug,url",
      "Vercel,vercel,https://boards.greenhouse.io/vercel",
      "Acme,acme,https://jobs.lever.co/acme",
      "Beta,beta,https://jobs.ashbyhq.com/beta",
      "",
    ].join("\n");
    const added = [
      { name: "Vercel", website: "https://vercel.com", isHiring: true },
      { name: "Acme", website: "https://acme.com", isHiring: true },
      { name: "Beta", website: "https://beta.com", isHiring: true },
    ];

    let active = 0;
    let maxActive = 0;
    function paced(build: () => Response): () => Promise<Response> {
      return () =>
        new Promise<Response>((resolve) => {
          active++;
          maxActive = Math.max(maxActive, active);
          setTimeout(() => {
            active--;
            resolve(build());
          }, 15);
        });
    }

    const { fetch } = buildFetch({
      jobhive,
      added,
      identity: {
        "greenhouse:vercel": paced(() => json({ name: "Vercel", content: "" })),
        "lever:acme": paced(() => text(`<html><head><title>Acme </title></head></html>`)),
        "ashby:beta": paced(
          () => text(`<script>window.__data={"organization":{"organizationId":"o1","name":"Beta","publicWebsite":"https://beta.com/"}};</script>`),
        ),
      },
      validate: { "greenhouse:vercel": ghJobs(5), "lever:acme": leverJobs(5), "ashby:beta": ashbyJobs(5) },
    });
    const repo = spyRepo();

    const report = await runGrowth({ fetch, sourcesRepo: repo, ...COMMON });

    expect(maxActive).toBe(1);
    expect(report.identityConfirmed).toBe(3);
    expect(report.seeded).toBe(3);
  });
});
