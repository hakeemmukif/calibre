// Task 0.3 — the source-discovery engine chain. Wires the six built-and-unit-
// tested modules into one run:
//
//   ingest (jobhive CSVs) -> niche (yc-oss + remoteintech) -> match
//     -> identity -> validate -> [seed]
//
// Every number this repo quotes about the engine (~9,935 rows, ~861 candidates,
// ~13% mis-attribution) is a projection from the datasets. The validate stage
// has never executed. This script is the ignition, and its default mode is
// `--dry-run`: run the whole chain, write a report with real counts, touch the
// DB zero times. Seeding requires an explicit `--seed`.
//
// DATASET ACCESS (plan D8, binding): yc-oss is fetched at RUNTIME and never
// vendored — the repo has no LICENSE (`license: null`), so fetching sidesteps
// redistribution. A fetch failure FAILS LOUD: no stale-cache fallback, no
// defaulting to an empty list (that would silently produce 0 candidates and
// read as "the engine found nothing").
// jobhive (MIT) and remoteintech (ISC) are safe to vendor but are not vendored
// today, and they are fetched at runtime too — one code path, no third copy of
// the truth to drift, and the same fail-loud posture for all three. The cost is
// that the engine needs network for its head stage; the benefit is that a run
// always reflects the live lists, which is the point of a discovery pass.
//
// POLITENESS (design §7, binding): every network call goes through an injected
// fetch and a per-host concurrency limit (validate.ts's limiter for validation,
// identity.ts's for identity). Any 403/429 from a vendor host STOPS that host
// for the rest of the pass — recorded, never retried, never routed around, and
// never with a spoofed UA. Other hosts continue.
//
// RESUMABILITY: the validate stage is ~90 minutes over ~5k slugs. Identity and
// validation results are appended to a JSONL checkpoint as each chunk lands, so
// a crash resumes from the last chunk instead of re-hitting every vendor
// endpoint. The checkpoint is bound to a digest of the candidate set: if the
// upstream lists moved under a resume, that is a hard error, not a merge.
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sourcesRepo as realSourcesRepo, type NewSource } from "../persistence/repos/sources";
import { parseJobhiveCsv, type JobhiveRow } from "./jobhive";
import { verifyIdentity, type IdentityVerdict } from "./identity";
import { matchNicheToJobhive, type EngineCandidate } from "./nicheFilter";
import { parseRemoteInTech, parseYcOss, type NicheCompany } from "./nicheList";
import { seedFromEngine } from "./seedFromEngine";
import { validateSlugs, type FetchLike, type ValidationResult } from "./validate";

// ---------------------------------------------------------------------------
// Dataset endpoints (real, per the plan's "Real source URLs")
// ---------------------------------------------------------------------------

// The contents API is used only to LIST a directory (2 calls per run, well
// inside the unauthenticated 60/hour limit). The per-file bodies come from the
// `download_url` each entry carries, which points at raw.githubusercontent.com
// and is not billed against the API limit.
const JOBHIVE_DIR_URL = "https://api.github.com/repos/kalil0321/ats-scrapers/contents/ats-companies";
const REMOTEINTECH_DIR_URL = "https://api.github.com/repos/remoteintech/remote-jobs/contents/src/companies";
const YC_OSS_URL = "https://yc-oss.github.io/api/companies/all.json";

const USER_AGENT = "Mozilla/5.0 (compatible; caliber-source-validator/1.0)";

const DEFAULT_REPORT_PATH = "docs/superpowers/reports/2026-07-17-engine-dry-run.md";
const DEFAULT_CHECKPOINT_PATH = ".cache/sources-engine-checkpoint.jsonl";
// Chunk = the resume granularity AND the blast radius of a 403: a stopped host
// is detected at the chunk boundary, so at most this many further requests
// reach it. 25 at concurrency 3 is ~9 waves — small enough to be polite, large
// enough that the checkpoint isn't fsync-bound.
const DEFAULT_CHUNK_SIZE = 25;

const STOP_REASONS = new Set(["forbidden", "rate_limited"]);
const STOP_STATUSES = new Set([403, 429]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AtsKind = JobhiveRow["ats"];

/** Only `bulkInsert` is ever called — narrowed so tests can spy with one method. */
export interface SourcesWriter {
  bulkInsert(rows: NewSource[]): Promise<unknown>;
}

export interface EngineOptions {
  /** Injected fetch — the engine never touches the global. */
  fetch: FetchLike;
  /** `false` (the default) = dry run: zero DB writes. */
  seed?: boolean;
  reportPath?: string;
  checkpointPath?: string;
  sourcesRepo?: SourcesWriter;
  now?: () => number;
  /** Passed to verifyIdentity; 0 in tests. */
  identityDelayMs?: number;
  concurrencyPerHost?: number;
  chunkSize?: number;
  log?: (message: string) => void;
}

export interface HostStop {
  stage: "identity" | "validate";
  host: string;
  reason: string;
  /** The candidate whose response triggered the stop. */
  triggeredBy: string;
}

export interface EngineReport {
  seeded: boolean;
  startedAt: number;
  finishedAt: number;
  jobhiveFiles: string[];
  jobhiveRows: number;
  jobhiveByAts: Record<string, number>;
  ycOssCompanies: number;
  remoteInTechCompanies: number;
  candidates: number;
  candidatesByAts: Record<string, number>;
  candidatesByMatchMethod: Record<string, number>;
  candidatesByProvenance: Record<string, number>;
  identity: { confirmed: number; mismatch: number; unverifiable: number; skippedHostStopped: number };
  identityByAts: Record<string, { confirmed: number; mismatch: number; unverifiable: number }>;
  unverifiableReasons: Record<string, number>;
  mismatchSamples: string[];
  validated: { live: number; notFound: number; otherHttp: number; networkError: number; skippedHostStopped: number };
  validatedByAts: Record<string, { live: number; notOk: number }>;
  liveJobCount: number;
  seedable: number;
  rowsWritten: number;
  hostStops: HostStop[];
}

// A candidate plus the niche identity it is claimed by.
interface ChainCandidate extends EngineCandidate {
  /** The niche list's name for the company — what identity.ts compares against. */
  expectedName: string;
  row: JobhiveRow;
  key: string;
}

// ---------------------------------------------------------------------------
// Dataset fetch — all three fail loud
// ---------------------------------------------------------------------------

async function fetchOk(fetchFn: FetchLike, url: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { "user-agent": USER_AGENT, accept: "application/vnd.github+json" } });
  } catch (err) {
    throw new Error(`engine: dataset fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status !== 200) {
    throw new Error(`engine: dataset fetch for ${url} returned HTTP ${res.status} (expected 200)`);
  }
  return res;
}

interface GithubEntry {
  name: string;
  type: string;
  download_url: string | null;
}

async function listGithubDir(fetchFn: FetchLike, dirUrl: string, extension: string): Promise<GithubEntry[]> {
  const body: unknown = await (await fetchOk(fetchFn, dirUrl)).json();
  if (!Array.isArray(body)) {
    throw new Error(`engine: ${dirUrl} did not return a directory listing (got ${typeof body})`);
  }
  const entries = (body as GithubEntry[]).filter((e) => e.type === "file" && e.name.endsWith(extension));
  if (entries.length === 0) {
    throw new Error(`engine: ${dirUrl} listed no ${extension} files — the upstream repo layout changed`);
  }
  for (const entry of entries) {
    if (!entry.download_url) {
      throw new Error(`engine: ${dirUrl} entry "${entry.name}" has no download_url`);
    }
  }
  return entries;
}

// Bounded fan-out for the per-file raw fetches (remoteintech is ~881 files).
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

// jobhive's `ats-companies/` directory holds one CSV per ATS platform it
// scrapes (27 as of 2026-07 — greenhouse/lever/ashby plus avature, bamboohr,
// workday, and 21 others). This engine only has connectors for the three
// listed here (connectors/index.ts FACTORIES: greenhouse, lever, ashby,
// jobstreet — jobstreet has no jobhive CSV), so those are the only files it
// is entitled to ingest. Handing parseJobhiveCsv a CSV from an unconnected
// ATS is not a parser bug: its rows genuinely fail the greenhouse/lever/ashby
// URL signatures, and the parser is right to throw. Phase 4 connectors
// (workable, personio, rippling, recruitee, pinpoint) extend this list as
// they land — their CSVs already exist in the same directory (~9,893 slugs
// waiting).
const JOBHIVE_ALLOWED_FILES = ["greenhouse.csv", "lever.csv", "ashby.csv"];

export async function fetchJobhive(fetchFn: FetchLike): Promise<{ files: string[]; rows: JobhiveRow[] }> {
  const entries = await listGithubDir(fetchFn, JOBHIVE_DIR_URL, ".csv");
  const allowed = entries.filter((e) => JOBHIVE_ALLOWED_FILES.includes(e.name));
  const missing = JOBHIVE_ALLOWED_FILES.filter((name) => !allowed.some((e) => e.name === name));
  if (missing.length > 0) {
    throw new Error(
      `engine: jobhive directory listing is missing allowlisted file(s) ${missing.join(", ")} — the dataset layout changed`,
    );
  }
  const texts = await mapLimit(allowed, 4, async (e) => (await fetchOk(fetchFn, e.download_url as string)).text());
  const rows = texts.flatMap((text) => parseJobhiveCsv(text));
  return { files: allowed.map((e) => e.name), rows };
}

async function fetchYcOss(fetchFn: FetchLike): Promise<NicheCompany[]> {
  return parseYcOss(await (await fetchOk(fetchFn, YC_OSS_URL)).json());
}

async function fetchRemoteInTech(fetchFn: FetchLike): Promise<NicheCompany[]> {
  const entries = await listGithubDir(fetchFn, REMOTEINTECH_DIR_URL, ".md");
  const files = await mapLimit(entries, 4, async (e) => ({
    path: e.name,
    content: await (await fetchOk(fetchFn, e.download_url as string)).text(),
  }));
  return parseRemoteInTech(files);
}

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

type CheckpointLine =
  | { v: 1; digest: string }
  | { stage: "identity"; key: string; verdict: IdentityVerdict }
  | { stage: "validate"; key: string; result: ValidationResult }
  | { stage: "identity" | "validate"; stop: HostStop };

interface Checkpoint {
  identity: Map<string, IdentityVerdict>;
  validate: Map<string, ValidationResult>;
  stops: HostStop[];
}

function digestOf(keys: string[]): string {
  return createHash("sha256").update([...keys].sort().join("\n")).digest("hex").slice(0, 16);
}

async function loadCheckpoint(path: string, digest: string): Promise<Checkpoint> {
  const empty: Checkpoint = { identity: new Map(), validate: new Map(), stops: [] };

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return empty;
    throw err;
  }

  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return empty;

  const header = JSON.parse(lines[0]) as CheckpointLine;
  if (!("v" in header) || header.v !== 1) {
    throw new Error(`engine: checkpoint "${path}" has no v1 header — delete it to start a fresh run`);
  }
  // A digest mismatch means the upstream lists moved since the interrupted run.
  // Merging the old results into the new candidate set would seed decisions
  // made about a different population, so this is a hard stop, not a fallback.
  if (header.digest !== digest) {
    throw new Error(
      `engine: checkpoint "${path}" was written for a different candidate set ` +
        `(checkpoint ${header.digest}, this run ${digest}) — the upstream lists changed. ` +
        `Delete the checkpoint to start a fresh run.`,
    );
  }

  const checkpoint: Checkpoint = { identity: new Map(), validate: new Map(), stops: [] };
  for (const line of lines.slice(1)) {
    const entry = JSON.parse(line) as CheckpointLine;
    if ("stop" in entry) {
      checkpoint.stops.push(entry.stop);
    } else if ("verdict" in entry) {
      checkpoint.identity.set(entry.key, entry.verdict);
    } else if ("result" in entry) {
      checkpoint.validate.set(entry.key, entry.result);
    }
  }
  return checkpoint;
}

async function initCheckpoint(path: string, digest: string): Promise<void> {
  const existing = await loadCheckpoint(path, digest);
  if (existing.identity.size > 0 || existing.validate.size > 0 || existing.stops.length > 0) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ v: 1, digest })}\n`, { flag: "a" });
}

async function appendCheckpoint(path: string, lines: CheckpointLine[]): Promise<void> {
  if (lines.length === 0) return;
  await appendFile(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// Chunked, host-stopping stage runner
// ---------------------------------------------------------------------------

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Runs one network stage over candidates grouped by vendor host: groups run
 * concurrently, chunks within a group run sequentially, and a chunk that yields
 * a 403/429 stops its group for the rest of the pass. Results land in `done`
 * and are checkpointed at every chunk boundary, so a crash never discards a
 * completed chunk.
 */
async function runStage<R>(args: {
  stage: "identity" | "validate";
  candidates: ChainCandidate[];
  hostOf: (candidate: ChainCandidate) => string;
  done: Map<string, R>;
  stops: HostStop[];
  chunkSize: number;
  checkpointPath: string;
  toLine: (key: string, result: R) => CheckpointLine;
  stopReasonOf: (result: R) => string | null;
  run: (chunk: ChainCandidate[]) => Promise<R[]>;
  log: (message: string) => void;
}): Promise<void> {
  const { stage, done, stops, checkpointPath, log } = args;
  const stoppedHosts = new Set(stops.filter((s) => s.stage === stage).map((s) => s.host));

  const groups = new Map<string, ChainCandidate[]>();
  for (const candidate of args.candidates) {
    if (done.has(candidate.key)) continue;
    const host = args.hostOf(candidate);
    const group = groups.get(host) ?? [];
    group.push(candidate);
    groups.set(host, group);
  }

  await Promise.all(
    [...groups].map(async ([host, group]) => {
      for (const batch of chunk(group, args.chunkSize)) {
        if (stoppedHosts.has(host)) return;

        const results = await args.run(batch);
        const lines: CheckpointLine[] = [];
        for (const [i, result] of results.entries()) {
          done.set(batch[i].key, result);
          lines.push(args.toLine(batch[i].key, result));
        }

        let stop: HostStop | null = null;
        for (const [i, result] of results.entries()) {
          const reason = args.stopReasonOf(result);
          if (reason !== null) {
            stop = { stage, host, reason, triggeredBy: batch[i].key };
            break;
          }
        }
        if (stop) {
          stoppedHosts.add(host);
          stops.push(stop);
          lines.push({ stage, stop });
          log(`engine: ${stage} host ${host} returned ${stop.reason} on ${stop.triggeredBy} — stopping this host`);
        }

        await appendCheckpoint(checkpointPath, lines);
        if (stop) return;
      }
    }),
  );
}

// Identity and validation hit different hosts per ATS, but each (stage, ats)
// pair is exactly one host — so the ATS is the host key, mirroring the URLs in
// identity.ts:endpointFor and validate.ts:endpointFor.
const IDENTITY_HOSTS: Record<AtsKind, string> = {
  greenhouse: "boards-api.greenhouse.io",
  lever: "jobs.lever.co",
  ashby: "jobs.ashbyhq.com",
};
const VALIDATE_HOSTS: Record<AtsKind, string> = {
  greenhouse: "boards-api.greenhouse.io",
  lever: "api.lever.co",
  ashby: "api.ashbyhq.com",
};

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

export async function runEngine(opts: EngineOptions): Promise<EngineReport> {
  const {
    fetch: fetchFn,
    seed = false,
    reportPath = DEFAULT_REPORT_PATH,
    checkpointPath = DEFAULT_CHECKPOINT_PATH,
    sourcesRepo = realSourcesRepo,
    now = Date.now,
    identityDelayMs,
    concurrencyPerHost,
    chunkSize = DEFAULT_CHUNK_SIZE,
    log = (m: string) => console.log(m),
  } = opts;

  const startedAt = now();

  // --- ingest + niche -------------------------------------------------------
  log("engine: fetching datasets (jobhive, yc-oss, remoteintech)…");
  const [jobhive, ycOss, remoteInTech] = await Promise.all([
    fetchJobhive(fetchFn),
    fetchYcOss(fetchFn),
    fetchRemoteInTech(fetchFn),
  ]);
  log(`engine: ${jobhive.rows.length} jobhive rows, ${ycOss.length} yc-oss, ${remoteInTech.length} remoteintech`);

  // --- match ----------------------------------------------------------------
  const niche = [...ycOss, ...remoteInTech];
  const matched = matchNicheToJobhive(niche, jobhive.rows);

  // The niche company's own name is what identity.ts must compare the vendor's
  // answer against — comparing jobhive's board name would be circular (the
  // vendor and jobhive agree by construction; that is how "Affinity.co" passes
  // as YC's "Affinity"). EngineCandidate carries `companyDomain`, which comes
  // verbatim off the matched NicheCompany, so the domain resolves the name.
  // Where two niche records share a domain the first wins; a name variant picked
  // that way can only cost a false MISMATCH (we decline to seed), never a false
  // confirm — the safe direction.
  const nicheByDomain = new Map<string, NicheCompany>();
  for (const company of niche) {
    if (!nicheByDomain.has(company.domain)) nicheByDomain.set(company.domain, company);
  }
  const rowByKey = new Map(jobhive.rows.map((r) => [`${r.ats}:${r.slug}`, r]));

  const candidates: ChainCandidate[] = matched.map((candidate) => {
    const key = `${candidate.ats}:${candidate.slug}`;
    const company = nicheByDomain.get(candidate.companyDomain);
    if (!company) {
      throw new Error(`engine: candidate ${key} has companyDomain "${candidate.companyDomain}" absent from the niche lists`);
    }
    const row = rowByKey.get(key);
    if (!row) {
      throw new Error(`engine: candidate ${key} has no jobhive row`);
    }
    return { ...candidate, expectedName: company.name, row, key };
  });
  log(`engine: ${candidates.length} candidates matched`);

  // --- checkpoint -----------------------------------------------------------
  const digest = digestOf(candidates.map((c) => c.key));
  const checkpoint = await loadCheckpoint(checkpointPath, digest);
  await initCheckpoint(checkpointPath, digest);
  if (checkpoint.identity.size > 0 || checkpoint.validate.size > 0) {
    log(`engine: resuming from ${checkpointPath} (${checkpoint.identity.size} identity, ${checkpoint.validate.size} validate)`);
  }

  // --- identity -------------------------------------------------------------
  await runStage<IdentityVerdict>({
    stage: "identity",
    candidates,
    hostOf: (c) => IDENTITY_HOSTS[c.ats],
    done: checkpoint.identity,
    stops: checkpoint.stops,
    chunkSize,
    checkpointPath,
    toLine: (key, verdict) => ({ stage: "identity", key, verdict }),
    stopReasonOf: (verdict) =>
      verdict.status === "unverifiable" && STOP_REASONS.has(verdict.reason) ? verdict.reason : null,
    run: (batch) =>
      Promise.all(
        batch.map((c) =>
          verifyIdentity(
            { name: c.expectedName, slug: c.slug, ats: c.ats, companyDomain: c.companyDomain, matchMethod: c.matchMethod },
            { fetch: fetchFn, ...(identityDelayMs === undefined ? {} : { politenessDelayMs: identityDelayMs }) },
          ),
        ),
      ),
    log,
  });

  // Identity gating is mandatory: only `confirmed` proceeds. `unverifiable` is
  // DROPPED, not seeded — the whole point of this gate is that ~13% of matches
  // are the wrong company, and an unverifiable board is one where the vendor
  // gave us no evidence either way. Seeding it would be a guess in exactly the
  // place the guess is known to be wrong 1-in-8 times. It is dropped BEFORE
  // validate, so unseedable candidates cost the vendor no further requests
  // (design §7) and no share of the 90-minute budget. Measured cost: ~0.9% of
  // live boards, most of which are dead boards validate would drop anyway.
  const confirmed = candidates.filter((c) => checkpoint.identity.get(c.key)?.status === "confirmed");
  log(`engine: ${confirmed.length} identity-confirmed of ${candidates.length}`);

  // --- validate -------------------------------------------------------------
  await runStage<ValidationResult>({
    stage: "validate",
    candidates: confirmed,
    hostOf: (c) => VALIDATE_HOSTS[c.ats],
    done: checkpoint.validate,
    stops: checkpoint.stops,
    chunkSize,
    checkpointPath,
    toLine: (key, result) => ({ stage: "validate", key, result }),
    stopReasonOf: (result) => (!result.ok && result.status !== undefined && STOP_STATUSES.has(result.status) ? result.reason : null),
    run: (batch) =>
      validateSlugs(
        batch.map((c) => ({ slug: c.slug, ats: c.ats })),
        { fetch: fetchFn, now, ...(concurrencyPerHost === undefined ? {} : { concurrencyPerHost }) },
      ),
    log,
  });

  // --- seed -----------------------------------------------------------------
  const seedable: { candidate: ChainCandidate; validation: ValidationResult }[] = [];
  for (const candidate of confirmed) {
    const validation = checkpoint.validate.get(candidate.key);
    if (validation?.ok) seedable.push({ candidate, validation });
  }

  let rowsWritten = 0;
  if (seed) {
    const rows = seedable.map(({ candidate, validation }) =>
      seedFromEngine(candidate.row, validation, ["jobhive", ...candidate.provenance], candidate.companyDomain),
    );
    if (rows.length > 0) {
      const inserted = (await sourcesRepo.bulkInsert(rows)) as unknown[];
      rowsWritten = Array.isArray(inserted) ? inserted.length : 0;
    }
    log(`engine: seeded ${rowsWritten} source row(s)`);
  } else {
    log(`engine: DRY RUN — ${seedable.length} row(s) would be seeded; nothing written`);
  }

  // --- report ---------------------------------------------------------------
  const report = buildReport({
    seed,
    startedAt,
    finishedAt: now(),
    jobhive,
    ycOss,
    remoteInTech,
    candidates,
    checkpoint,
    seedable: seedable.length,
    rowsWritten,
  });
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, renderReport(report), "utf8");
  log(`engine: report written to ${reportPath}`);

  return report;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const MISMATCH_SAMPLE_LIMIT = 25;

function buildReport(args: {
  seed: boolean;
  startedAt: number;
  finishedAt: number;
  jobhive: { files: string[]; rows: JobhiveRow[] };
  ycOss: NicheCompany[];
  remoteInTech: NicheCompany[];
  candidates: ChainCandidate[];
  checkpoint: Checkpoint;
  seedable: number;
  rowsWritten: number;
}): EngineReport {
  const { candidates, checkpoint } = args;

  const jobhiveByAts: Record<string, number> = {};
  for (const row of args.jobhive.rows) bump(jobhiveByAts, row.ats);

  const candidatesByAts: Record<string, number> = {};
  const candidatesByMatchMethod: Record<string, number> = {};
  const candidatesByProvenance: Record<string, number> = {};
  for (const c of candidates) {
    bump(candidatesByAts, c.ats);
    bump(candidatesByMatchMethod, c.matchMethod);
    bump(candidatesByProvenance, [...c.provenance].sort().join("+"));
  }

  const identity = { confirmed: 0, mismatch: 0, unverifiable: 0, skippedHostStopped: 0 };
  const identityByAts: Record<string, { confirmed: number; mismatch: number; unverifiable: number }> = {};
  const unverifiableReasons: Record<string, number> = {};
  const mismatchSamples: string[] = [];

  for (const c of candidates) {
    const verdict = checkpoint.identity.get(c.key);
    if (!verdict) {
      identity.skippedHostStopped++;
      continue;
    }
    identity[verdict.status]++;
    const byAts = (identityByAts[c.ats] ??= { confirmed: 0, mismatch: 0, unverifiable: 0 });
    byAts[verdict.status]++;
    if (verdict.status === "unverifiable") bump(unverifiableReasons, verdict.reason);
    if (verdict.status === "mismatch" && mismatchSamples.length < MISMATCH_SAMPLE_LIMIT) {
      mismatchSamples.push(verdict.evidence);
    }
  }

  const confirmed = candidates.filter((c) => checkpoint.identity.get(c.key)?.status === "confirmed");
  const validated = { live: 0, notFound: 0, otherHttp: 0, networkError: 0, skippedHostStopped: 0 };
  const validatedByAts: Record<string, { live: number; notOk: number }> = {};
  let liveJobCount = 0;

  for (const c of confirmed) {
    const result = checkpoint.validate.get(c.key);
    const byAts = (validatedByAts[c.ats] ??= { live: 0, notOk: 0 });
    if (!result) {
      validated.skippedHostStopped++;
      continue;
    }
    if (result.ok) {
      validated.live++;
      byAts.live++;
      liveJobCount += result.jobCount;
      continue;
    }
    byAts.notOk++;
    if (result.status === undefined) validated.networkError++;
    else if (result.status === 404) validated.notFound++;
    else validated.otherHttp++;
  }

  return {
    seeded: args.seed,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    jobhiveFiles: args.jobhive.files,
    jobhiveRows: args.jobhive.rows.length,
    jobhiveByAts,
    ycOssCompanies: args.ycOss.length,
    remoteInTechCompanies: args.remoteInTech.length,
    candidates: candidates.length,
    candidatesByAts,
    candidatesByMatchMethod,
    candidatesByProvenance,
    identity,
    identityByAts,
    unverifiableReasons,
    mismatchSamples,
    validated,
    validatedByAts,
    liveJobCount,
    seedable: args.seedable,
    rowsWritten: args.rowsWritten,
    hostStops: checkpoint.stops,
  };
}

function table(title: string, counts: Record<string, number>): string {
  const keys = Object.keys(counts).sort();
  if (keys.length === 0) return `${title}: (none)\n`;
  return [`| ${title} | count |`, "|---|---|", ...keys.map((k) => `| ${k} | ${counts[k]} |`), ""].join("\n");
}

export function renderReport(r: EngineReport): string {
  const minutes = ((r.finishedAt - r.startedAt) / 60000).toFixed(1);
  const lines: string[] = [
    `# Source engine — ${r.seeded ? "SEED run" : "dry run"}`,
    "",
    `Generated by \`npm run sources:engine\`. Mode: **${r.seeded ? "--seed" : "--dry-run (default)"}**.`,
    `Started ${new Date(r.startedAt).toISOString()}, finished ${new Date(r.finishedAt).toISOString()} (${minutes} min).`,
    "",
    "## 1. Ingest — jobhive",
    "",
    `Files: ${r.jobhiveFiles.join(", ")}`,
    `Rows ingested: **${r.jobhiveRows}**`,
    "",
    table("ats", r.jobhiveByAts),
    "## 2. Niche lists",
    "",
    `- yc-oss: **${r.ycOssCompanies}** companies with a usable domain`,
    `- remoteintech: **${r.remoteInTechCompanies}** companies with a usable domain`,
    "",
    "## 3. Match",
    "",
    `Candidates: **${r.candidates}**`,
    "",
    table("ats", r.candidatesByAts),
    table("matchMethod", r.candidatesByMatchMethod),
    table("provenance", r.candidatesByProvenance),
    "## 4. Identity",
    "",
    `- confirmed: **${r.identity.confirmed}**`,
    `- mismatch (dropped): **${r.identity.mismatch}**`,
    `- unverifiable (dropped): **${r.identity.unverifiable}**`,
    `- skipped, host stopped: **${r.identity.skippedHostStopped}**`,
    "",
    "| ats | confirmed | mismatch | unverifiable |",
    "|---|---|---|---|",
    ...Object.keys(r.identityByAts)
      .sort()
      .map((a) => `| ${a} | ${r.identityByAts[a].confirmed} | ${r.identityByAts[a].mismatch} | ${r.identityByAts[a].unverifiable} |`),
    "",
    table("unverifiable reason", r.unverifiableReasons),
    "### Mismatch samples (real mis-attributions this run caught)",
    "",
    ...(r.mismatchSamples.length === 0 ? ["(none)"] : r.mismatchSamples.map((s) => `- ${s}`)),
    "",
    "## 5. Validate (identity-confirmed only)",
    "",
    `- live 200: **${r.validated.live}** (${r.liveJobCount} jobs total)`,
    `- 404: **${r.validated.notFound}**`,
    `- other HTTP: **${r.validated.otherHttp}**`,
    `- network errors: **${r.validated.networkError}**`,
    `- skipped, host stopped: **${r.validated.skippedHostStopped}**`,
    "",
    "| ats | live | not ok |",
    "|---|---|---|",
    ...Object.keys(r.validatedByAts)
      .sort()
      .map((a) => `| ${a} | ${r.validatedByAts[a].live} | ${r.validatedByAts[a].notOk} |`),
    "",
    "## 6. Seed",
    "",
    `- ${r.seeded ? "rows written" : "projected seed count (nothing written)"}: **${r.seeded ? r.rowsWritten : r.seedable}**`,
    "",
    "## 7. Host stops (403/429 — design §7 stop signals)",
    "",
    ...(r.hostStops.length === 0
      ? ["(none)"]
      : r.hostStops.map((s) => `- \`${s.stage}\` host \`${s.host}\` — ${s.reason}, triggered by \`${s.triggeredBy}\``)),
    "",
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface Cli {
  seed: boolean;
  reportPath: string;
  checkpointPath: string;
}

/** `--dry-run` is the default; `--seed` is the only way to write to the DB. */
export function parseArgs(argv: string[]): Cli {
  const cli: Cli = { seed: false, reportPath: DEFAULT_REPORT_PATH, checkpointPath: DEFAULT_CHECKPOINT_PATH };
  let dryRun = false;

  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--seed") cli.seed = true;
    else if (arg.startsWith("--report=")) cli.reportPath = arg.slice("--report=".length);
    else if (arg.startsWith("--checkpoint=")) cli.checkpointPath = arg.slice("--checkpoint=".length);
    else throw new Error(`sources:engine: unknown argument "${arg}" (expected --dry-run | --seed | --report=<path> | --checkpoint=<path>)`);
  }

  if (dryRun && cli.seed) {
    throw new Error("sources:engine: --dry-run and --seed are contradictory — pass one");
  }
  return cli;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cli = parseArgs(process.argv.slice(2));
  runEngine({ fetch: (url, init) => fetch(url, init), ...cli })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
