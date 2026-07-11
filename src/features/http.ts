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

// Fetch + `.parse` the response with the frozen Zod schema — a contract
// drift between this client and the route handler throws here, at the
// boundary, instead of silently handing the UI a malformed object. A
// non-2xx response is parsed as `ErrorEnvelope` and re-thrown as `ApiError`
// so callers can surface `error.message` (and branch on `error.code`).
export async function requestJson<T>(
  input: string,
  init: RequestInit | undefined,
  schema: ParseableSchema<T>,
): Promise<T> {
  const res = await fetch(input, init);
  const body: unknown = await res.json();
  if (!res.ok) {
    const envelope = ErrorEnvelope.parse(body);
    throw new ApiError(res.status, envelope.error.code, envelope.error.message, envelope.error.details);
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
