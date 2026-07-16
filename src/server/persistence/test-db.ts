// libsql test harness. Every repo test creates its own isolated instance via
// createTestDb() and applies the committed drizzle/*.sql migrations — the same
// SQL that runs against the real file DB via `db:migrate`.
//
// Backed by a unique temp FILE, not `:memory:`: @libsql/client's local driver
// recreates its underlying connection when a transaction begins, and a fresh
// `:memory:` connection is a private empty DB — so migrated tables vanish
// inside any `db.transaction(...)`. A per-test file is shared across those
// connection recreations (as the prod file DB is), so transactions see the
// schema, while a unique name keeps tests isolated. Files are cleaned up on
// process exit.
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "./schema";
import type { Db } from "./repos/db";

const migrationsDir = join(__dirname, "../../../drizzle");

// Vitest reloads this module per test file (isolate: true), so module-level
// state resets while `process` stays shared. Anchor the file list + the single
// exit listener on globalThis so we register exactly one listener across all
// test files (no MaxListenersExceededWarning) and it still sees every temp file.
const g = globalThis as typeof globalThis & {
  __caliberTestDbFiles?: string[];
  __caliberTestDbCleanupRegistered?: boolean;
};
const tempDbFiles: string[] = (g.__caliberTestDbFiles ??= []);

export type TestDb = Db;

export async function createTestDb(): Promise<TestDb> {
  const path = join(tmpdir(), `caliber-test-${randomUUID()}.db`);
  tempDbFiles.push(path);
  if (!g.__caliberTestDbCleanupRegistered) {
    g.__caliberTestDbCleanupRegistered = true;
    process.once("exit", () => {
      for (const f of tempDbFiles) {
        // "" + rollback-journal / WAL siblings — default mode uses -journal;
        // -wal/-shm are harmless no-ops unless WAL is ever enabled here.
        for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(f + suffix, { force: true });
      }
    });
  }
  const client = createClient({ url: `file:${path}` });
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
