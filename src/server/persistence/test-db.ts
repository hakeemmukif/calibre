// In-memory libsql test harness. Every repo test creates its own isolated
// instance via createTestDb() and applies the committed drizzle/*.sql migrations
// — same SQL that runs against a real file DB via `db:migrate`.
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "./schema";
import type { Db } from "./repos/db";

const migrationsDir = join(__dirname, "../../../drizzle");

export type TestDb = Db;

export async function createTestDb(): Promise<TestDb> {
  const client = createClient({ url: ":memory:" });
  await client.execute("PRAGMA foreign_keys = ON");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    await client.executeMultiple(sql);
  }
  return drizzle(client, { schema });
}
