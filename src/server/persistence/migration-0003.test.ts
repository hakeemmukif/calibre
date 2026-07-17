import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createTestDb } from "./test-db";
import { crawlRuns, jobs, postings } from "./schema";
import { insertJob, insertSource } from "./repos/__fixtures__/helpers";

const migrationsDir = join(__dirname, "../../../drizzle");
const MIGRATION_0003 = "0003_misty_blindfold.sql";

describe("0003 global postings pool migration", () => {
  it("0003 is additive-only (drizzle is forward-only — no down)", () => {
    const sql = readFileSync(join(migrationsDir, MIGRATION_0003), "utf-8");
    // No destructive statements — the pool only ADDs tables/columns/indexes.
    expect(sql).not.toMatch(/\bdrop\b/i);
    expect(sql).not.toMatch(/\brename\b/i);
    expect(sql).not.toMatch(/\bdelete\s+from\b/i);
    // The three things it must add.
    expect(sql).toMatch(/create table `postings`/i);
    expect(sql).toMatch(/create table `crawl_runs`/i);
    expect(sql).toMatch(/alter table `jobs` add `posting_id`/i);
    // The FK behavior the arch pins (§1.3): a pool purge must never cascade
    // into a user's history. drizzle-kit drops ON DELETE on ADD COLUMN, so this
    // clause is asserted explicitly to guard the hand-corrected SQL.
    expect(sql.toLowerCase()).toContain("on delete set null");
  });

  const leftovers: string[] = [];
  afterAll(() => {
    for (const f of leftovers) for (const s of ["", "-journal", "-wal", "-shm"]) rmSync(f + s, { force: true });
  });

  it("applies cleanly on top of a populated 0002 DB, preserving existing rows", async () => {
    const path = join(tmpdir(), `caliber-mig0003-${randomUUID()}.db`);
    leftovers.push(path);
    const client = createClient({ url: `file:${path}` });
    await client.execute("PRAGMA foreign_keys = ON");

    // Apply 0000..0002 — the live migration head — then seed a user (a row that
    // must survive the additive 0003).
    const upTo0002 = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql") && f < MIGRATION_0003)
      .sort();
    for (const f of upTo0002) await client.executeMultiple(readFileSync(join(migrationsDir, f), "utf-8"));

    const uid = randomUUID();
    await client.execute({
      sql: "INSERT INTO users (id, email, password_hash, role, plan, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      args: [uid, `u-${uid}@example.com`, "hash", "user", "standard", Date.now()],
    });

    // Now apply 0003 on top.
    await client.executeMultiple(readFileSync(join(migrationsDir, MIGRATION_0003), "utf-8"));

    // Pre-existing row survived; new tables exist and accept writes; jobs gained
    // the nullable posting_id column.
    const users = await client.execute("SELECT id FROM users WHERE id = ?", [uid]);
    expect(users.rows).toHaveLength(1);
    await client.execute("SELECT id, canonical_key, description, department, function_tag_version FROM postings");
    await client.execute("SELECT id, started_at, status, stats FROM crawl_runs");
    await client.execute("SELECT posting_id FROM jobs");
    client.close();
  });

  it("jobs.posting_id is ON DELETE SET NULL — a pool purge never deletes the user's job", async () => {
    const db = await createTestDb();
    const source = await insertSource(db);
    const [posting] = await db
      .insert(postings)
      .values({
        canonicalKey: "purge-me",
        url: "https://example.com/purge",
        sourceId: source.id,
        title: "Role",
        company: "Co",
        location: "Remote",
        persona: "remote",
        aliases: [],
        raw: {},
      })
      .returning();

    const job = await insertJob(db, source.id, { postingId: posting.id });
    expect(job.postingId).toBe(posting.id);

    await db.delete(postings).where(eq(postings.id, posting.id));

    const [survivor] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(survivor).toBeDefined();
    expect(survivor.postingId).toBeNull();

    const remaining = await db.select().from(crawlRuns); // table is queryable
    expect(remaining).toEqual([]);
  });
});
