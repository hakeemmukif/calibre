// Shared HTTP transport for connectors — TS port of career-ops/providers/
// _http.mjs's fetchJson (timeout + user-agent + non-2xx → thrown Error).
// Files prefixed with `_` are helpers, not connectors themselves.
//
// Raw-body tee (2026-07-21-raw-crawl-archive-design.md §2a): fetchJson/
// postJson/fetchText all read the body as text first, then on a 2xx response
// tee {url,method,status,contentType,body,fetchedAt} to the active archive
// writer — but ONLY when archiveContext has a store (a crawl is running).
// No connector signature changes; a fetch outside a crawl (e.g. scan-time
// fetchDetail) is never archived.
import { archiveContext } from "../../sources/archive";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; caliber/1.0)";

export interface FetchJsonOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  redirect?: RequestRedirect;
  signal?: AbortSignal;
}

export class ConnectorHttpError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ConnectorHttpError";
    this.status = status;
  }
}

function teeResponse(url: string, method: string, res: Response, body: string): void {
  const ctx = archiveContext.getStore();
  if (!ctx) return;
  ctx.writer.archiveResponse(ctx.sourceId, {
    url,
    method,
    status: res.status,
    contentType: res.headers.get("content-type"),
    body,
    fetchedAt: new Date().toISOString(),
  });
}

export async function fetchJson(url: string, opts: FetchJsonOptions = {}): Promise<unknown> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, redirect = "follow", signal } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "user-agent": DEFAULT_USER_AGENT, ...headers },
      redirect,
      signal: combined,
    });
    const bodyText = await res.text().catch(() => "");
    if (!res.ok) {
      throw new ConnectorHttpError(`HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 300)}` : ""}`, res.status);
    }
    teeResponse(url, "GET", res, bodyText);
    return JSON.parse(bodyText);
  } finally {
    clearTimeout(timer);
  }
}

export async function postJson(url: string, body: unknown, opts: FetchJsonOptions = {}): Promise<unknown> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, signal } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "user-agent": DEFAULT_USER_AGENT, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: combined,
    });
    const bodyText = await res.text().catch(() => "");
    if (!res.ok) {
      throw new ConnectorHttpError(`HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 300)}` : ""}`, res.status);
    }
    teeResponse(url, "POST", res, bodyText);
    return JSON.parse(bodyText);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchText(url: string, opts: FetchJsonOptions = {}): Promise<string> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, redirect = "follow", signal } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "user-agent": DEFAULT_USER_AGENT, ...headers },
      redirect,
      signal: combined,
    });
    const bodyText = await res.text();
    if (!res.ok) {
      throw new ConnectorHttpError(`HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 300)}` : ""}`, res.status);
    }
    teeResponse(url, "GET", res, bodyText);
    return bodyText;
  } finally {
    clearTimeout(timer);
  }
}
