// In-process liveness probe (system-architecture.md §2 "liveness rebuilt
// in-process ... HTTP probe + optional Playwright, same active|expired|
// uncertain" — no `check-liveness.mjs` shell-out). Plain HTTP is the primary
// signal; a manual redirect loop (not `redirect:'follow'`) so the ≤3-hop cap
// is enforced explicitly and each hop is independently testable with a
// stubbed fetch.
export type LivenessResult = "active" | "expired" | "uncertain";

export interface LivenessProbeOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  maxRedirects?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_REDIRECTS = 3;

export async function probeLiveness(url: string, opts: LivenessProbeOptions = {}): Promise<LivenessResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let currentUrl = url;
  try {
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetchFn(currentUrl, { method: "GET", redirect: "manual", signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) return "uncertain";
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (res.status >= 200 && res.status < 300) return "active";
      if (res.status === 404 || res.status === 410) return "expired";
      return "uncertain";
    }
    return "uncertain"; // exceeded the redirect budget without landing
  } catch {
    return "uncertain";
  }
}

// Optional Playwright fallback for JS-gated pages whose plain-HTTP status is
// inconclusive (e.g. a board that always 200s and renders "no longer
// accepting applications" client-side). Guarded behind an env flag so it is
// completely inert (no Chromium spawn, no `playwright` import even
// attempted) unless an operator has confirmed Playwright/browsers are
// actually installed in the runtime image — this is what keeps unit tests
// browserless without needing to mock this module.
const EXPIRED_MARKERS = [/no longer accepting applications/i, /position (has been )?filled/i, /job not found/i];

async function probeWithPlaywright(url: string): Promise<LivenessResult> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    if (!response) return "uncertain";
    const text = await page.textContent("body");
    if (text && EXPIRED_MARKERS.some((re) => re.test(text))) return "expired";
    return response.ok() ? "active" : "uncertain";
  } finally {
    await browser.close();
  }
}

export async function probeLivenessDeep(url: string, opts: LivenessProbeOptions = {}): Promise<LivenessResult> {
  const plain = await probeLiveness(url, opts);
  if (plain !== "uncertain") return plain;
  if (process.env.CALIBER_LIVENESS_PLAYWRIGHT !== "1") return plain;
  try {
    return await probeWithPlaywright(url);
  } catch {
    return "uncertain";
  }
}
