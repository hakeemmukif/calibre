// Shared repo db type: both the real libsql client (db.ts) and the temp-file
// libsql test client (test-db.ts) are the same LibSQLDatabase over `typeof
// schema` — repos are written once against this type and work against either.
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type * as schema from "../schema";

export type Db = LibSQLDatabase<typeof schema>;
