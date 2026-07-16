// Shared fetch wrapper for every features/*/client.ts module (api-contract.md
// §5 "features/* fetch wrappers take/return z.infer types and .parse
// responses in dev/test"). This is the ONLY place a non-2xx response is
// turned into something the UI can show — every client function reuses it
// instead of re-implementing error mapping per route.
import { ErrorEnvelope } from "@/types";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorEnvelope["error"]["code"];
  readonly details?: unknown;

  constructor(status: number, code: ErrorEnvelope["error"]["code"], message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface ParseableSchema<T> {
  parse(value: unknown): T;
}

interface RawResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

// Concurrent callers of the same GET URL share one fetch — a page that
// fires several `requestJson` calls for the same resource (e.g. a
// re-render storm) must not cost several network round-trips. Keyed by URL
// only, so each caller still `.parse`s the shared raw body through its OWN
// schema. Deleted in `finally` — this is in-flight coalescing, not a cache;
// nothing is retained once the fetch settles.
const inFlightGets = new Map<string, Promise<RawResponse>>();

async function fetchRaw(input: string, init: RequestInit | undefined): Promise<RawResponse> {
  const res = await fetch(input, init);
  const raw = await res.text();
  let body: unknown;
  try {
    body = raw.length > 0 ? JSON.parse(raw) : undefined;
  } catch {
    body = undefined;
  }
  return { ok: res.ok, status: res.status, body };
}

function fetchRawDeduped(input: string, init: RequestInit | undefined): Promise<RawResponse> {
  const isGet = !init?.method || init.method === "GET";
  if (!isGet) return fetchRaw(input, init);

  const existing = inFlightGets.get(input);
  if (existing) return existing;

  const promise = fetchRaw(input, init).finally(() => inFlightGets.delete(input));
  inFlightGets.set(input, promise);
  return promise;
}

// Fetch + `.parse` the response with the frozen Zod schema — a contract
// drift between this client and the route handler throws here, at the
// boundary, instead of silently handing the UI a malformed object. A
// non-2xx response is parsed as `ErrorEnvelope` and re-thrown as `ApiError`
// so callers can surface `error.message` (and branch on `error.code`).
//
// The body is read as text and JSON-parsed defensively: an error response
// that ISN'T a JSON `ErrorEnvelope` — an empty-body bare 500, an HTML error
// page, a proxy timeout — must still surface as a clean `ApiError` carrying
// the status, never as a raw `SyntaxError: Unexpected end of JSON input`
// leaking to the UI (which is what an unconditional `res.json()` produced).
export async function requestJson<T>(
  input: string,
  init: RequestInit | undefined,
  schema: ParseableSchema<T>,
): Promise<T> {
  const { ok, status, body } = await fetchRawDeduped(input, init);
  if (!ok) {
    const envelope = ErrorEnvelope.safeParse(body);
    if (envelope.success) {
      throw new ApiError(status, envelope.data.error.code, envelope.data.error.message, envelope.data.error.details);
    }
    throw new ApiError(status, "INTERNAL", `Request failed with status ${status}.`);
  }
  return schema.parse(body);
}

// Same as `requestJson`, but a 404 resolves to `null` instead of throwing —
// for the "absence is not an error" routes (`GET /api/resume`).
export async function requestJsonOrNull<T>(
  input: string,
  init: RequestInit | undefined,
  schema: ParseableSchema<T>,
): Promise<T | null> {
  try {
    return await requestJson(input, init, schema);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}
