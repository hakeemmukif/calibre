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
  // FK enforcement is OFF by default in SQLite; our cascades/set-null need it.
  void client.execute("PRAGMA foreign_keys = ON");
  // WAL + busy_timeout only apply to a local file DB; remote libsql handles
  // concurrency server-side.
  if (url.startsWith("file:")) {
    void client.execute("PRAGMA journal_mode = WAL");
    void client.execute("PRAGMA busy_timeout = 5000");
  }
}
