// PGlite (in-memory Postgres) test harness. Every repo test creates its own
// isolated instance via createTestDb() and applies the committed drizzle/*.sql
// migrations — same SQL that runs against real Postgres via `db:migrate`.
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "./schema";

const migrationsDir = join(__dirname, "../../../drizzle");

export type TestDb = PgliteDatabase<typeof schema>;

export async function createTestDb(): Promise<TestDb> {
  const pglite = new PGlite();
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    await pglite.exec(sql);
  }
  return drizzle(pglite, { schema });
}
