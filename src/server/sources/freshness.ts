// Task 2.6 — freshness + ATS re-detection loop over engine-seeded sources
// (spec 2026-07-16-remote-startup-niche-source-expansion-design.md §4.3 step
// 5): each pass revalidates via validateSlugs; a not-ok result increments
// `config.consecutiveFailures`, a 200 resets it to 0 and refreshes
// `lastValidatedAt`/`jobCount`. At 3 consecutive failures the row goes
// `status='dead'` and re-detection runs — fetch the company careers page,
// scan for the ATS-signature regexes, and if the company moved ATS rewrite
// `config.connector`/`config.slug` in place. A dead slug heals or is visibly
// disabled — never silently 404s forever.
//
// Cron note: weekly scheduling is operational wiring, out of scope here —
// an operator/scheduler calls runFreshnessPass; this function is the
// testable unit.
//
// Decisions this module encodes:
// - Engine rows are the ones with a `provenance` array in config (only
//   seedFromEngine writes one); hand-curated seed.ts rows carry no health
//   fields and are skipped. An engine row with malformed health fields
//   throws — no defaulting.
// - Careers-URL derivation: config carries `companyDomain` (not the vendor
//   `careers_url` the spec mentions — that column never landed in config),
//   so re-detection tries `https://{companyDomain}/careers` then the bare
//   domain root `https://{companyDomain}/`, first 200 page with a MOVED
//   signature wins. A signature equal to the current (connector, slug) is
//   not a move — that exact endpoint just 404'd three times.
// - On a re-detection hit the row goes back to `status:'active'` with
//   `consecutiveFailures: 0` PENDING the next validation pass — no immediate
//   revalidateSlugs call, the next weekly pass confirms the rewrite.
// - "Visibly disabled": a dead row with no signature gets `enabled: false`,
//   which the scan path already respects (search/run.ts fetches sources via
//   listEnabledByPersona, WHERE enabled = true); `status:'dead'` stays in
//   config for the admin surface (listAll) to count.
// - Rows already dead are skipped (re-detection ran when they died); healing
//   a long-dead row is an admin action from the sources page.
// - Re-detection is bounded (S2): `config.redetectHistory` records every
//   signature this row has already been moved OFF, and a signature on that
//   list is never adopted again. See TERMINATION below.
// - A network error is not a 404 (S2b): see NETWORK_DEAD_THRESHOLD.
// - One corrupt row does not abort the pass (S3): see FreshnessPassError.
import type { SourceRow } from "../persistence/repos/sources";
import type { JobhiveAts } from "./jobhive";
import type { SourceConfig } from "./seedFromEngine";
import { validateSlugs, type FetchLike } from "./validate";

// A confirmed HTTP not-ok (404/403/...) is the vendor telling us the board is
// gone — 3 of those in a row is enough to act on.
const DEAD_THRESHOLD = 3;
// S2b: a rejected fetch (DNS blip, ECONNRESET, timeout) is the ABSENCE of an
// answer, not an answer. Treating it identically to a 404 means three unlucky
// weeks of transient failure permanently disable a healthy source — a
// false-positive death that costs a real company's jobs. Ignoring network
// errors entirely is the opposite failure: a host that is permanently gone
// (domain expired, DNS pulled) would never die. So they count on the same
// `consecutiveFailures` counter, but a streak made only of network errors
// needs twice as many strikes to kill the row. A confirmed HTTP not-ok still
// kills at DEAD_THRESHOLD, even if earlier strikes in the streak were network
// errors — once the vendor has answered, we have confirmation and no longer
// need the extra patience. No new config field, no backoff scheduler.
const NETWORK_DEAD_THRESHOLD = 6;
// TERMINATION (S2): `redetectHistory` never shrinks and a signature on it is
// never re-adopted, so on a fixed careers page re-detection can adopt each of
// the (at most 3) distinct vendor signatures once before exhausting. That
// alone bounds the common case. This cap covers the pathological one — a
// careers page that serves a NEW slug on every fetch would otherwise offer an
// endless supply of untried signatures. Either way the row lands in
// `dead_disabled`.
const MAX_REDETECTIONS = 3;
const USER_AGENT = "Mozilla/5.0 (compatible; caliber-source-freshness/1.0)";
const ATS_KINDS: readonly JobhiveAts[] = ["greenhouse", "lever", "ashby"];

// The three ATS-signature regexes, same shapes as jobhive.ts's URL parsers
// (spec §4.3 step 5) but unanchored — here they scan a whole careers-page
// HTML document, not a lone URL. Both greenhouse public hosts accepted
// (boards. and job-boards. — the §4.3 step 3 host trap).
const SIGNATURES: ReadonlyArray<{ connector: JobhiveAts; re: RegExp }> = [
  { connector: "greenhouse", re: /(?:boards|job-boards)\.greenhouse\.io\/([\w-]+)/i },
  { connector: "lever", re: /jobs\.lever\.co\/([\w-]+)/i },
  { connector: "ashby", re: /jobs\.ashbyhq\.com\/([\w.-]+)/i },
];

export interface AtsSignature {
  connector: JobhiveAts;
  slug: string;
}

/**
 * Scans careers-page HTML for ATS-signature URLs. Returns the first slug
 * found per ATS, in greenhouse/lever/ashby order (mirrors jobhive.ts's
 * extraction order).
 *
 * CAVEAT (accepted, not fixed): within one vendor `re.exec` takes the
 * DOCUMENT-FIRST occurrence, so a stale same-vendor link sitting above the
 * live one (an old footer, a blog post) wins over the real board. Ranking
 * links by liveness on arbitrary careers HTML is out of scope; the bounded
 * re-detection below is what stops that mis-pick from becoming an unbounded
 * loop — a wrong slug is tried at most once and then permanently retired to
 * `redetectHistory`.
 */
export function detectAtsSignatures(html: string): AtsSignature[] {
  const found: AtsSignature[] = [];
  for (const { connector, re } of SIGNATURES) {
    const match = re.exec(html);
    if (match) found.push({ connector, slug: match[1] });
  }
  return found;
}

export type FreshnessOutcome =
  | { id: string; action: "revalidated_ok"; jobCount: number }
  | { id: string; action: "failure_recorded"; consecutiveFailures: number }
  | { id: string; action: "redetected"; connector: JobhiveAts; slug: string }
  | { id: string; action: "dead_disabled" }
  | { id: string; action: "skipped_dead" }
  | { id: string; action: "config_malformed"; message: string };

/**
 * S3: thrown after a pass in which one or more rows carried a corrupt config.
 * The corruption stays fail-loud (CLAUDE.md) but is scoped to the ROW — the
 * remaining ~4,000 rows are still processed and their outcomes ride along on
 * `outcomes` rather than being discarded with the throw. Chosen over a plain
 * `{ outcomes, failures }` return because a returned failure list is trivial
 * to ignore at the call site; a throw is not.
 */
export class FreshnessPassError extends Error {
  readonly outcomes: FreshnessOutcome[];
  readonly failures: ReadonlyArray<{ id: string; message: string }>;

  constructor(outcomes: FreshnessOutcome[], failures: Array<{ id: string; message: string }>) {
    super(
      `freshness: pass completed with ${failures.length} malformed source row(s):\n` +
        failures.map((f) => `  - ${f.id}: ${f.message}`).join("\n"),
    );
    this.name = "FreshnessPassError";
    this.outcomes = outcomes;
    this.failures = failures;
  }
}

// `redetectHistory` extends the seeded SourceConfig shape (seedFromEngine
// does not write it — a never-re-detected row simply has none), so it is
// declared here rather than in seedFromEngine.ts.
type EngineConfig = SourceConfig & { redetectHistory?: string[] };

function signatureKey(connector: JobhiveAts, slug: string): string {
  return `${connector}:${slug}`;
}

export interface FreshnessRepo {
  listAll(): Promise<SourceRow[]>;
  update(
    id: string,
    patch: { config?: Record<string, unknown>; enabled?: boolean },
  ): Promise<SourceRow | undefined>;
}

export interface RunFreshnessPassOptions {
  repo: FreshnessRepo;
  /** Injected fetch — never the global, same discipline as validate.ts. */
  fetch: FetchLike;
  /** Clock injection for `lastValidatedAt`. Defaults to `Date.now`. */
  now?: () => number;
}

function isEngineRow(row: SourceRow): boolean {
  return Array.isArray((row.config as Record<string, unknown>).provenance);
}

// Fail loud on an engine row with malformed health fields — a row that
// carries provenance but lacks the seedFromEngine shape is corrupt data,
// not something to default around.
function parseEngineConfig(row: SourceRow): EngineConfig {
  const c = row.config as Record<string, unknown>;
  const fail = (field: string): never => {
    throw new Error(
      `freshness: engine source "${row.id}" has malformed config field "${field}" (got ${JSON.stringify(c[field])})`,
    );
  };
  if (typeof c.connector !== "string" || !ATS_KINDS.includes(c.connector as JobhiveAts)) fail("connector");
  if (typeof c.slug !== "string" || !c.slug) fail("slug");
  if (typeof c.companyDomain !== "string" || !c.companyDomain) fail("companyDomain");
  if (typeof c.consecutiveFailures !== "number") fail("consecutiveFailures");
  if (c.status !== "active" && c.status !== "dead") fail("status");
  // Absent is legal — rows seeded before re-detection ever ran have no
  // history. Present-but-wrong-typed is corruption, not something to default
  // around.
  if (
    c.redetectHistory !== undefined &&
    (!Array.isArray(c.redetectHistory) || c.redetectHistory.some((s) => typeof s !== "string"))
  ) {
    fail("redetectHistory");
  }
  return c as unknown as EngineConfig;
}

// Careers-URL derivation (documented above): /careers first, bare root
// second. A non-200 or a thrown fetch (dead domain) is a no-signal for that
// URL — an expected domain outcome for a company that shut down, same
// fail-visible-not-thrown stance as validate.ts's 404 handling.
// `tried` holds every signature already known to be a dead end: the current
// (connector, slug) — that exact endpoint just failed its way to the
// threshold — plus every signature this row has previously been moved off.
// A hit inside `tried` is not a move, it is the loop trying to close.
async function redetect(
  config: EngineConfig,
  fetchFn: FetchLike,
  tried: ReadonlySet<string>,
): Promise<AtsSignature | null> {
  const urls = [`https://${config.companyDomain}/careers`, `https://${config.companyDomain}/`];
  for (const url of urls) {
    let res: Response;
    try {
      res = await fetchFn(url, { headers: { "user-agent": USER_AGENT } });
    } catch {
      continue;
    }
    if (res.status !== 200) continue;
    const html = await res.text();
    const moved = detectAtsSignatures(html).find((sig) => !tried.has(signatureKey(sig.connector, sig.slug)));
    if (moved) return moved;
  }
  return null;
}

// Every config write spreads the row's existing config first, so keys this
// module knows nothing about (notably `geo`, which search/run.ts reads per
// scan — dropping it would brick the row) survive every rewrite.
async function processRow(
  row: SourceRow,
  config: EngineConfig,
  fetchFn: FetchLike,
  now: () => number,
  repo: FreshnessRepo,
): Promise<FreshnessOutcome> {
  const existing = row.config as Record<string, unknown>;

  if (config.status === "dead") return { id: row.id, action: "skipped_dead" };

  const [result] = await validateSlugs([{ slug: config.slug, ats: config.connector }], {
    fetch: fetchFn,
    now,
  });

  if (result.ok) {
    await repo.update(row.id, {
      config: {
        ...existing,
        consecutiveFailures: 0,
        lastValidatedAt: result.lastValidatedAt,
        jobCount: result.jobCount,
      },
    });
    return { id: row.id, action: "revalidated_ok", jobCount: result.jobCount };
  }

  const consecutiveFailures = config.consecutiveFailures + 1;
  // S2b: `status` is absent only on the network-error variant of the union.
  const threshold = result.reason === "network_error" ? NETWORK_DEAD_THRESHOLD : DEAD_THRESHOLD;
  if (consecutiveFailures < threshold) {
    await repo.update(row.id, { config: { ...existing, consecutiveFailures } });
    return { id: row.id, action: "failure_recorded", consecutiveFailures };
  }

  const history = config.redetectHistory ?? [];
  const tried = new Set([...history, signatureKey(config.connector, config.slug)]);
  const detected =
    history.length >= MAX_REDETECTIONS ? null : await redetect(config, fetchFn, tried);

  if (detected) {
    await repo.update(row.id, {
      config: {
        ...existing,
        connector: detected.connector,
        slug: detected.slug,
        consecutiveFailures: 0,
        status: "active",
        // Retire the signature we are moving OFF, so it can never be adopted
        // again. This list is what makes the loop terminate.
        redetectHistory: [...history, signatureKey(config.connector, config.slug)],
      },
    });
    return { id: row.id, action: "redetected", connector: detected.connector, slug: detected.slug };
  }

  // No untried signature left (or the cap is spent): give up visibly.
  // `enabled: false` drops the row from listEnabledByPersona, and
  // `redetectHistory` tells an operator on the sources page exactly which
  // endpoints were tried before the row was retired.
  await repo.update(row.id, {
    config: { ...existing, consecutiveFailures, status: "dead" },
    enabled: false,
  });
  return { id: row.id, action: "dead_disabled" };
}

/**
 * One revalidation pass over the engine-seeded sources. Returns one outcome
 * per engine row (hand-curated rows are not engine rows and get none) for
 * cron logging / the admin dead-count.
 *
 * Throws {@link FreshnessPassError} if any row's config was corrupt — after
 * every other row has been processed. Rows updated before the corrupt one
 * keep their writes, and their outcomes are carried on the error.
 */
export async function runFreshnessPass(opts: RunFreshnessPassOptions): Promise<FreshnessOutcome[]> {
  const { repo, fetch: fetchFn, now = Date.now } = opts;

  const engineRows = (await repo.listAll()).filter(isEngineRow);
  const outcomes: FreshnessOutcome[] = [];
  const failures: Array<{ id: string; message: string }> = [];

  for (const row of engineRows) {
    // S3: fail loud on the ROW, not on the PASS. A single corrupt config out
    // of ~4,000 must not starve every row after it.
    let config: EngineConfig;
    try {
      config = parseEngineConfig(row);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ id: row.id, message });
      outcomes.push({ id: row.id, action: "config_malformed", message });
      continue;
    }

    outcomes.push(await processRow(row, config, fetchFn, now, repo));
  }

  if (failures.length) throw new FreshnessPassError(outcomes, failures);
  return outcomes;
}
