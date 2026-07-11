// Shared path-param validation. DB id columns are Postgres `uuid`
// (schema.ts) — a malformed value in `WHERE id = ...` throws
// `invalid input syntax for type uuid`, surfacing as a bare 500. Routes
// short-circuit malformed ids to 404 NOT_FOUND (the documented code for
// "no such id" — no contract change) before touching the DB.
import { z } from "zod";

export const UuidParam = z.string().uuid();

export function isUuid(value: string): boolean {
  return UuidParam.safeParse(value).success;
}
