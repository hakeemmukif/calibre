import { isUuid } from "@/server/http/params";

// Shared keyset-cursor codec. `decodeCursorId` throws a typed
// InvalidCursorError (never a raw SyntaxError) so list routes can map a
// garbage `?cursor=` to 422 VALIDATION_ERROR instead of leaking a 500.
//
// The cursor stores only `{ id }`, never the row's ordering column
// (firstSeenAt/appliedAt): the comparison tuple is re-fetched fresh from the
// DB (full microsecond precision) rather than round-tripped through a JS
// `Date` (millisecond precision). Embedding the timestamp in the cursor
// instead would silently drop rows sharing a millisecond with the cursor
// row — do not "optimize" this by inlining it.
export class InvalidCursorError extends Error {
  constructor(cursor: string) {
    super(`Malformed cursor: ${cursor}`);
    this.name = "InvalidCursorError";
  }
}

export function encodeCursorId(id: string): string {
  return Buffer.from(JSON.stringify({ id })).toString("base64url");
}

export function decodeCursorId(cursor: string): { id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
  } catch {
    throw new InvalidCursorError(cursor);
  }
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as { id?: unknown }).id !== "string") {
    throw new InvalidCursorError(cursor);
  }
  const { id } = parsed as { id: string };
  if (!isUuid(id)) {
    throw new InvalidCursorError(cursor);
  }
  return { id };
}
