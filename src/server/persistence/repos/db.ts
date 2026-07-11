// Shared repo db type: both the real postgres-js client (db.ts) and the
// PGlite test client (test-db.ts) extend drizzle-orm's PgDatabase over the
// same `typeof schema` — repos are written once against this common type and
// work against either. `any` for the query-result HKT param sidesteps the
// two drivers' distinct (and irrelevant to query-building) result-kind types.
import type { PgDatabase } from "drizzle-orm/pg-core";
import type * as schema from "../schema";

export type Db = PgDatabase<any, typeof schema>;
