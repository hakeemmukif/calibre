// Tier-1 acquisition (pasted-job-ingestion spec §7): direct fetch of a
// pasted job URL. SSRF is un-deferred — assertPublicHttpUrl runs before the
// initial request AND is re-run on every redirect hop (manual redirects via
// Location, mirrors liveness.ts's per-hop loop — a redirect can retarget to
// a private address after the first check passes). Any {ok:false} is a soft
// failure for the caller (server/url-check/run.ts escalates to the sonar
// search tier); only a non-SsrfBlockedError bug propagates (fail-loud).
import { htmlToText } from "@/server/search/connectors/_html";
import { assertPublicHttpUrl, SsrfBlockedError } from "./ssrf";

export type FetchPageResult =
  | { ok: true; text: string; pageTitle?: string }
  | { ok: false; reason: "blocked" | "empty" | "oversize" | "error" };

export const MAX_TEXT_CHARS = 40_000;
export const MIN_TEXT_CHARS = 400;
export const MAX_BYTES = 2_000_000;

const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

export async function fetchPageText(url: string): Promise<FetchPageResult> {
  let currentUrl: URL;
  try {
    currentUrl = new URL(url);
  } catch {
    return { ok: false, reason: "error" };
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    try {
      await assertPublicHttpUrl(currentUrl);
    } catch (err) {
      if (err instanceof SsrfBlockedError) return { ok: false, reason: "blocked" };
      throw err;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(currentUrl.toString(), { method: "GET", redirect: "manual", signal: controller.signal });
    } catch {
      clearTimeout(timer);
      return { ok: false, reason: "error" };
    }

    if (res.status >= 300 && res.status < 400) {
      clearTimeout(timer);
      const location = res.headers.get("location");
      if (!location) return { ok: false, reason: "error" };
      currentUrl = new URL(location, currentUrl);
      continue;
    }

    if (res.status < 200 || res.status >= 300) {
      clearTimeout(timer);
      return { ok: false, reason: "error" };
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!/^text\/(html|plain)/i.test(contentType.trim())) {
      clearTimeout(timer);
      return { ok: false, reason: "blocked" };
    }

    const body = await readBodyCapped(res, controller);
    clearTimeout(timer);
    if (!body.ok) return { ok: false, reason: "oversize" };

    const raw = new TextDecoder().decode(body.bytes);
    const text = htmlToText(raw);
    if (text.length < MIN_TEXT_CHARS) return { ok: false, reason: text.length === 0 ? "empty" : "blocked" };
    if (text.length > MAX_TEXT_CHARS) return { ok: false, reason: "oversize" };
    return { ok: true, text };
  }

  return { ok: false, reason: "error" };
}

async function readBodyCapped(
  res: Response,
  controller: AbortController,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.byteLength > MAX_BYTES ? { ok: false } : { ok: true, bytes: buf };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      controller.abort();
      await reader.cancel().catch(() => {});
      return { ok: false };
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: merged };
}
