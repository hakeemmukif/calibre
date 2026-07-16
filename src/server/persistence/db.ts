// libsql singleton. Every server/* module gets its Drizzle client from here —
// nothing outside src/server/persistence may import @libsql/client directly.
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema";

let db: LibSQLDatabase<typeof schema> | undefined;

export function getDb(): LibSQLDatabase<typeof schema> {
  if (db) return db;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN });
  applyPragmas(client, url);
  db = drizzle(client, { schema });
  return db;
}

function applyPragmas(client: Client, url: string): void {
  // Only a local file DB needs client-issued pragmas: FK enforcement is OFF by
  // default in SQLite (our cascades/set-null need it on), and WAL + busy_timeout
  // tune local file concurrency. A remote libsql (Turso) url gets none of these —
  // the remote server already defaults foreign_keys ON and manages concurrency
  // itself, so issuing them here would be a no-op and an unhandled-rejection risk.
  if (url.startsWith("file:")) {
    void client.execute("PRAGMA foreign_keys = ON");
    void client.execute("PRAGMA journal_mode = WAL");
    void client.execute("PRAGMA busy_timeout = 5000");
  }
}
