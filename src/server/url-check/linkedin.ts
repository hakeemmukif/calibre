// LinkedIn job-URL rewrite for tier-1 fetch (F7 spec): a pasted LinkedIn job
// URL normally hits the authwall SPA and degrades to "paste text". LinkedIn's
// public guest endpoint (`/jobs-guest/jobs/api/jobPosting/{id}`) serves the
// same posting as server-rendered HTML with no login, so rewriting the URL
// before the fetch turns that into an automatic tier-1 success.
//
// Known limitation: dedupeKeyFor (src/server/search/dedupe.ts) is not
// LinkedIn-aware, so `/jobs/view/{id}` and `?currentJobId={id}` normalize to
// different dedupe keys — the same job pasted two ways creates two rows.
// Intentionally NOT fixed here: dedupeKeyFor is shared with the scan
// pipeline, and rekeying it would orphan existing rows.

const GUEST_ORIGIN = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting";

function isLinkedInHost(hostname: string): boolean {
  return hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
}

function jobIdFromViewPath(pathname: string): string | undefined {
  if (!pathname.startsWith("/jobs/view/")) return undefined;
  return /(\d+)\/?$/.exec(pathname)?.[1];
}

function jobIdFromCurrentJobIdParam(url: URL): string | undefined {
  const id = url.searchParams.get("currentJobId");
  return id && /^\d+$/.test(id) ? id : undefined;
}

/** True for LinkedIn's public guest job-posting endpoint, never a substring match on other paths. */
export function isLinkedInGuestUrl(url: URL): boolean {
  return isLinkedInHost(url.hostname) && /^\/jobs-guest\/jobs\/api\/jobPosting\/\d+$/.test(url.pathname);
}

/**
 * Rewrites a LinkedIn job URL to the public guest endpoint. Passthrough
 * (returns `url` unchanged) for anything that isn't a LinkedIn job URL with a
 * numeric job id — never guesses an id. The origin is hardcoded; the id is
 * the only variable part and is `/^\d+$/`-validated before use.
 */
export function normalizeJobUrl(url: URL): URL {
  if (!isLinkedInHost(url.hostname)) return url;

  const jobId = jobIdFromViewPath(url.pathname) ?? jobIdFromCurrentJobIdParam(url);
  if (!jobId) return url;

  return new URL(`${GUEST_ORIGIN}/${jobId}`);
}
