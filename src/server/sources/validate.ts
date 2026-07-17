// Endpoint validation for candidate (slug, ats) rows discovered upstream —
// task 2.4. Only a real HTTP 200 against the ATS's listing endpoint makes a
// candidate eligible to seed; every other status is an explicit not-ok
// result (fail-visible, not thrown — a 404/403/429 is an expected domain
// outcome here, not a bug). `fetch` is always injected; the exported
// functions never touch the global.
//
// Endpoint URLs mirror the real connectors verbatim (do not invent shapes):
//   greenhouse: src/server/search/connectors/greenhouse.ts:73
//     `https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true` -> { jobs: [...] }
//   lever:      src/server/search/connectors/lever.ts:42
//     `https://api.lever.co/v0/postings/{slug}` -> [...] (bare array)
//   ashby:      src/server/search/connectors/ashby.ts:56
//     `https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true` -> { jobs: [...] }
//
// Greenhouse public boards are reachable from two host names
// (boards.greenhouse.io and job-boards.greenhouse.io), both valid for slug
// provenance upstream — but the connector's real API host is the single
// canonical one (boards-api.greenhouse.io), so validation never branches on
// origin host; every greenhouse candidate hits the same API endpoint.

export type AtsKind = "greenhouse" | "lever" | "ashby";

export interface CandidateSlug {
  slug: string;
  ats: AtsKind;
}

export interface ValidationOk {
  ok: true;
  jobCount: number;
  lastValidatedAt: number;
}

export interface ValidationHttpNotOk {
  ok: false;
  status: number;
  reason: string;
}

// A rejected `fetch` (ECONNRESET, DNS failure, timeout) is the same class of
// expected crawl outcome as a 404 — the endpoint was reachable-or-not, not a
// bug in this module. It carries no HTTP status because none was ever
// received; `status` stays absent rather than a sentinel like `0` (that
// would silently claim an HTTP round-trip happened). Declaring it
// `status?: undefined` — rather than omitting the key — keeps `.status`
// (and `.reason`) accessible with a truthful `number | undefined` /
// `string` type across the whole `ValidationNotOk` union for existing
// callers, without narrowing first.
export interface ValidationNetworkError {
  ok: false;
  status?: undefined;
  reason: "network_error";
  detail: string;
}

export type ValidationNotOk = ValidationHttpNotOk | ValidationNetworkError;

export type ValidationResult = ValidationOk | ValidationNotOk;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ValidateSlugsOptions {
  /** Injected fetch — never the global, so this stays a pure test double in unit tests. */
  fetch: FetchLike;
  /** Clock injection for `lastValidatedAt`. Defaults to `Date.now`. */
  now?: () => number;
  /** Max concurrent in-flight requests per vendor host. Default 3 (politeness range 2-4). */
  concurrencyPerHost?: number;
}

const DEFAULT_CONCURRENCY_PER_HOST = 3;
const USER_AGENT = "Mozilla/5.0 (compatible; caliber-source-validator/1.0)";

// Explicit status -> reason mapping (task requirement: never silently treat
// a non-200 as ok). Unlisted statuses still produce a not-ok result, just
// with a generic reason instead of a named one.
const STATUS_REASONS: Record<number, string> = {
  404: "not_found",
  403: "forbidden",
  429: "rate_limited",
};

function reasonForStatus(status: number): string {
  return STATUS_REASONS[status] ?? `http_${status}`;
}

function endpointFor(candidate: CandidateSlug): { url: string; host: string } {
  const { slug, ats } = candidate;
  let url: string;
  switch (ats) {
    case "greenhouse":
      url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
      break;
    case "lever":
      url = `https://api.lever.co/v0/postings/${slug}`;
      break;
    case "ashby":
      url = `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;
      break;
    default:
      throw new Error(`validateSlugs: unknown ats kind "${String(ats)}" for slug "${slug}"`);
  }
  return { url, host: new URL(url).host };
}

function jobCountFor(ats: AtsKind, body: unknown): number {
  if (ats === "lever") {
    if (!Array.isArray(body)) {
      throw new Error(`validateSlugs: lever 200 body was not an array (got ${typeof body})`);
    }
    return body.length;
  }
  const jobs = (body as { jobs?: unknown[] } | null)?.jobs;
  if (!Array.isArray(jobs)) {
    throw new Error(`validateSlugs: ${ats} 200 body had no "jobs" array`);
  }
  return jobs.length;
}

// Per-host semaphore. Kept module-local and rebuilt per `validateSlugs` call
// so runs don't share state across operator invocations.
function createHostLimiter(maxConcurrent: number) {
  const active = new Map<string, number>();
  const waiters = new Map<string, Array<() => void>>();

  function acquire(host: string): Promise<void> {
    const inFlight = active.get(host) ?? 0;
    if (inFlight < maxConcurrent) {
      active.set(host, inFlight + 1);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const queue = waiters.get(host) ?? [];
      queue.push(resolve);
      waiters.set(host, queue);
    });
  }

  function release(host: string): void {
    const queue = waiters.get(host) ?? [];
    const next = queue.shift();
    if (next) {
      next(); // hand the freed slot straight to the next waiter
      return;
    }
    active.set(host, Math.max(0, (active.get(host) ?? 1) - 1));
  }

  return async function run<T>(host: string, fn: () => Promise<T>): Promise<T> {
    await acquire(host);
    try {
      return await fn();
    } finally {
      release(host);
    }
  };
}

async function validateOne(candidate: CandidateSlug, fetchFn: FetchLike, now: () => number): Promise<ValidationResult> {
  const { url } = endpointFor(candidate);
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { "user-agent": USER_AGENT } });
  } catch (err) {
    // Expected crawl outcome (see ValidationNetworkError) — never let this
    // reject the caller's Promise.all and discard sibling results.
    return { ok: false, reason: "network_error", detail: err instanceof Error ? err.message : String(err) };
  }

  if (res.status === 200) {
    const body = await res.json();
    return { ok: true, jobCount: jobCountFor(candidate.ats, body), lastValidatedAt: now() };
  }
  return { ok: false, status: res.status, reason: reasonForStatus(res.status) };
}

export async function validateSlugs(
  candidates: CandidateSlug[],
  opts: ValidateSlugsOptions,
): Promise<ValidationResult[]> {
  const { fetch: fetchFn, now = Date.now, concurrencyPerHost = DEFAULT_CONCURRENCY_PER_HOST } = opts;
  const limiter = createHostLimiter(concurrencyPerHost);

  return Promise.all(
    candidates.map((candidate) => {
      const { host } = endpointFor(candidate);
      return limiter(host, () => validateOne(candidate, fetchFn, now));
    }),
  );
}
