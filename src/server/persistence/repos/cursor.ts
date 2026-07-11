// Shared keyset-cursor codec. `decodeCursorId` throws a typed
// InvalidCursorError (never a raw SyntaxError) so list routes can map a
// garbage `?cursor=` to 422 VALIDATION_ERROR instead of leaking a 500.
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
  return { id: (parsed as { id: string }).id };
}
