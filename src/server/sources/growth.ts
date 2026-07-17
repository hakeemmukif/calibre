// Task O.3 — `sources:growth`: the local persona's path off a static list.
//
// engine.ts's full pass matches the ~9.9k jobhive rows against the ENTIRE
// yc-oss `companies/all.json` (6,050 records) — a 90-minute run meant to be
// re-run occasionally, not daily. New YC companies need a cheaper daily path:
// yc-oss publishes a diff endpoint that lists only what changed since the
// last snapshot. This module fetches that diff, runs ONLY the newly-added
// companies through the same match -> identity -> validate -> seed chain
// (reusing engine.ts's + identity.ts's + validate.ts's + seedFromEngine.ts's
// exported stage functions verbatim — no `runEngine` refactor needed), and
// seeds. `all.json` (the 6,050 full list) is NEVER fetched here — that is
// the entire cost this module exists to avoid.
//
// ENDPOINT (verified live 2026-07-17 — the obvious guess
// `.../api/companies/changes/latest.json` 404s):
//   https://yc-oss.github.io/api/changes/latest.json
//   -> { generated_at, summary: { previous_total, current_total, added,
//        removed, updated }, added: [...], removed: [...], updated: [...] }
// `added[]` entries carry the same shape as `all.json` records (name/
// website/isHiring), so `parseYcOss(payload.added)` works verbatim.
//
// jobhive IS fetched every run, unconditionally — `matchNicheToJobhive` needs
// the full jobhive (ats, slug) lookup to match the diff against, and there is
// no "optional" network path here (mirrors engine.ts's D8 fail-loud, one-
// path-always posture). `fetchJobhive` is module-private to engine.ts; it is
// exported from there (one-line change) rather than duplicated (~60 lines).
//
// DEDUPE: candidate ids (`${prefix}:${slug}`, seedFromEngine.ts's mapping) are
// checked against already-seeded ids BEFORE identity/validate run, so a
// company seeded by an earlier engine or growth pass costs this pass zero
// vendor requests. `bulkInsert`'s `onConflictDoNothing` is the backstop, not
// the plan.
//
// POLITENESS (design §7, binding): engine.ts's private `runStage` (per-host
// chunking + host-stop tracking) is NOT reused here — at N≈7 added/day the
// sufficient policy is simpler: any 403/429, from any stage, aborts the WHOLE
// pass, fail loud. No retry, no routing around, no partial seed.
//
// GAP-DAY RISK: `latest.json` covers only the most recent diff. A missed cron
// day loses those additions permanently from this path — there is no lookback
// window. The backstop is an occasional full `npm run sources:engine --seed`,
// which is idempotent via `onConflictDoNothing` and will pick up anything
// growth missed. See the crontab note this task reports back.
import { fileURLToPath } from "node:url";
import { sourcesRepo as realSourcesRepo, type NewSource } from "../persistence/repos/sources";
import { fetchJobhive, type AtsKind } from "./engine";
import { verifyIdentity, type IdentityVerdict } from "./identity";
import type { JobhiveRow } from "./jobhive";
import { matchNicheToJobhive, type EngineCandidate } from "./nicheFilter";
import { parseYcOss, type NicheCompany } from "./nicheList";
import { seedFromEngine } from "./seedFromEngine";
import { validateSlugs, type FetchLike, type ValidationResult } from "./validate";

const YC_OSS_CHANGES_URL = "https://yc-oss.github.io/api/changes/latest.json";
const USER_AGENT = "Mozilla/5.0 (compatible; caliber-source-validator/1.0)";

const STOP_REASONS = new Set(["forbidden", "rate_limited"]);
const STOP_STATUSES = new Set([403, 429]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Only the two methods this module calls — narrowed so tests can spy with both. */
export interface GrowthSourcesWriter {
  bulkInsert(rows: NewSource[]): Promise<unknown[]>;
  listAll(): Promise<{ id: string }[]>;
}

export interface GrowthOptions {
  /** Injected fetch — never the global, so this stays a pure test double in unit tests. */
  fetch: FetchLike;
  sourcesRepo?: GrowthSourcesWriter;
  now?: () => number;
  /** Passed to verifyIdentity; 0 in tests. */
  identityDelayMs?: number;
  log?: (message: string) => void;
}

export interface GrowthReport {
  added: number;
  matched: number;
  skippedAlreadySeeded: number;
  identityConfirmed: number;
  identityDropped: number;
  validatedLive: number;
  validatedNotOk: number;
  seeded: number;
}

// A matched candidate plus the niche identity it is claimed by — mirrors
// engine.ts's private ChainCandidate.
interface GrowthCandidate extends EngineCandidate {
  expectedName: string;
  row: JobhiveRow;
  key: string;
}

// ---------------------------------------------------------------------------
// yc-oss diff fetch — fails loud, same posture as engine.ts's dataset fetches
// ---------------------------------------------------------------------------

async function fetchYcOssAdded(fetchFn: FetchLike): Promise<unknown[]> {
  let res: Response;
  try {
    res = await fetchFn(YC_OSS_CHANGES_URL, { headers: { "user-agent": USER_AGENT, accept: "application/json" } });
  } catch (err) {
    throw new Error(`growth: dataset fetch failed for ${YC_OSS_CHANGES_URL}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status !== 200) {
    throw new Error(`growth: dataset fetch for ${YC_OSS_CHANGES_URL} returned HTTP ${res.status} (expected 200)`);
  }

  const body: unknown = await res.json();
  const added = (body as { added?: unknown } | null)?.added;
  if (!Array.isArray(added)) {
    throw new Error(`growth: ${YC_OSS_CHANGES_URL} did not return the expected {..., added: [...]} shape`);
  }
  return added;
}

// ---------------------------------------------------------------------------
// Match — ~25 lines duplicated from engine.ts:434-463 (candidate construction)
// ---------------------------------------------------------------------------

function buildCandidates(added: NicheCompany[], jobhive: JobhiveRow[]): GrowthCandidate[] {
  const matched = matchNicheToJobhive(added, jobhive);

  // The niche company's own name is what identity.ts compares the vendor's
  // answer against (see engine.ts's identical comment) — the first record to
  // claim a domain wins, which can only cost a false MISMATCH, never a false
  // confirm.
  const nicheByDomain = new Map<string, NicheCompany>();
  for (const company of added) {
    if (!nicheByDomain.has(company.domain)) nicheByDomain.set(company.domain, company);
  }
  const rowByKey = new Map(jobhive.map((r) => [`${r.ats}:${r.slug}`, r]));

  return matched.map((candidate) => {
    const key = `${candidate.ats}:${candidate.slug}`;
    const company = nicheByDomain.get(candidate.companyDomain);
    if (!company) {
      throw new Error(`growth: candidate ${key} has companyDomain "${candidate.companyDomain}" absent from the added companies`);
    }
    const row = rowByKey.get(key);
    if (!row) {
      throw new Error(`growth: candidate ${key} has no jobhive row`);
    }
    return { ...candidate, expectedName: company.name, row, key };
  });
}

// Mirrors seedFromEngine.ts's ID_PREFIX, which is module-private there.
// Duplicated here ONLY so the id can be computed before the chain runs, to
// skip already-seeded companies without spending an identity/validate request
// on them. Must stay in sync with seedFromEngine.ts's ID_PREFIX.
const ID_PREFIX: Record<AtsKind, string> = { greenhouse: "gh", lever: "lever", ashby: "ashby" };

function idOf(candidate: { ats: AtsKind; slug: string }): string {
  return `${ID_PREFIX[candidate.ats]}:${candidate.slug}`;
}

// ---------------------------------------------------------------------------
// Politeness — any 403/429 aborts the whole pass (design §7; see file header)
// ---------------------------------------------------------------------------

function assertNoIdentityStop(candidates: GrowthCandidate[], verdicts: IdentityVerdict[]): void {
  for (const [i, verdict] of verdicts.entries()) {
    if (verdict.status === "unverifiable" && STOP_REASONS.has(verdict.reason)) {
      throw new Error(
        `growth: identity check for ${candidates[i].key} returned "${verdict.reason}" — aborting the pass ` +
          `(design §7: any 403/429 stops the run, never routed around; N≈7/day makes per-host chunking unnecessary)`,
      );
    }
  }
}

function assertNoValidateStop(candidates: GrowthCandidate[], results: ValidationResult[]): void {
  for (const [i, result] of results.entries()) {
    if (!result.ok && result.status !== undefined && STOP_STATUSES.has(result.status)) {
      throw new Error(
        `growth: validation for ${candidates[i].key} returned HTTP ${result.status} (${result.reason}) — aborting the pass ` +
          `(design §7: any 403/429 stops the run, never routed around)`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

export async function runGrowth(opts: GrowthOptions): Promise<GrowthReport> {
  const {
    fetch: fetchFn,
    sourcesRepo = realSourcesRepo,
    now = Date.now,
    identityDelayMs,
    log = (m: string) => console.log(m),
  } = opts;

  log("growth: fetching yc-oss changes/latest.json…");
  const added = parseYcOss(await fetchYcOssAdded(fetchFn));
  log(`growth: ${added.length} added compan${added.length === 1 ? "y" : "ies"} in the latest diff`);

  // jobhive is fetched unconditionally — not gated on `added.length > 0` (see
  // file header: "no optional network path here").
  log("growth: fetching jobhive…");
  const jobhive = await fetchJobhive(fetchFn);
  log(`growth: ${jobhive.rows.length} jobhive rows`);

  const candidates = buildCandidates(added, jobhive.rows);
  log(`growth: ${candidates.length} candidate(s) matched against jobhive`);

  const existingIds = new Set((await sourcesRepo.listAll()).map((r) => r.id));
  const fresh = candidates.filter((c) => !existingIds.has(idOf(c)));
  const skippedAlreadySeeded = candidates.length - fresh.length;
  if (skippedAlreadySeeded > 0) {
    log(`growth: ${skippedAlreadySeeded} candidate(s) already seeded — skipped before identity/validate`);
  }

  // --- identity ---------------------------------------------------------
  const verdicts = await Promise.all(
    fresh.map((c) =>
      verifyIdentity(
        { name: c.expectedName, slug: c.slug, ats: c.ats, companyDomain: c.companyDomain, matchMethod: c.matchMethod },
        { fetch: fetchFn, ...(identityDelayMs === undefined ? {} : { politenessDelayMs: identityDelayMs }) },
      ),
    ),
  );
  assertNoIdentityStop(fresh, verdicts);

  const confirmed: GrowthCandidate[] = [];
  let identityDropped = 0;
  for (const [i, verdict] of verdicts.entries()) {
    if (verdict.status === "confirmed") confirmed.push(fresh[i]);
    else identityDropped++;
  }
  log(`growth: ${confirmed.length} identity-confirmed of ${fresh.length}`);

  // --- validate -----------------------------------------------------------
  const results = await validateSlugs(
    confirmed.map((c) => ({ slug: c.slug, ats: c.ats })),
    { fetch: fetchFn, now },
  );
  assertNoValidateStop(confirmed, results);

  // --- seed -----------------------------------------------------------------
  const rows: NewSource[] = [];
  let validatedLive = 0;
  for (const [i, result] of results.entries()) {
    if (!result.ok) continue;
    validatedLive++;
    const candidate = confirmed[i];
    rows.push(seedFromEngine(candidate.row, result, ["jobhive", ...candidate.provenance], candidate.companyDomain));
  }

  let seeded = 0;
  if (rows.length > 0) {
    const inserted = await sourcesRepo.bulkInsert(rows);
    seeded = Array.isArray(inserted) ? inserted.length : 0;
  }
  log(`growth: seeded ${seeded} new source row(s)`);

  return {
    added: added.length,
    matched: candidates.length,
    skippedAlreadySeeded,
    identityConfirmed: confirmed.length,
    identityDropped,
    validatedLive,
    validatedNotOk: results.length - validatedLive,
    seeded,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runGrowth({ fetch: (url, init) => fetch(url, init) })
    .then((report) => {
      console.log(`growth: done — ${JSON.stringify(report)}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
