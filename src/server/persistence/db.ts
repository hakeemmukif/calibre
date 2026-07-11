// Real-Postgres singleton. Every server/* module gets its Drizzle client from
// here — nothing outside src/server/persistence (and src/server/persistence
// consumers) may import the `postgres` driver directly.
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

let db: PostgresJsDatabase<typeof schema> | undefined;

export function getDb(): PostgresJsDatabase<typeof schema> {
  if (db) return db;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = postgres(url);
  db = drizzle(client, { schema });
  return db;
}
