import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { sessions, users } from "../schema";
import { createSessionRepo } from "./sessions";

async function seedUser(db: Awaited<ReturnType<typeof createTestDb>>) {
  const [u] = await db.insert(users).values({ email: "s@x.co", passwordHash: "h", role: "user", plan: "standard" }).returning();
  return u;
}

async function readLastUsedAt(db: Awaited<ReturnType<typeof createTestDb>>, tokenHash: string) {
  const [row] = await db.select({ lastUsedAt: sessions.lastUsedAt }).from(sessions).where(eq(sessions.tokenHash, tokenHash));
  return row.lastUsedAt;
}

describe("sessionsRepo", () => {
  it("create then findUserByTokenHash returns the owning user", async () => {
    const db = await createTestDb();
    const u = await seedUser(db);
    const repo = createSessionRepo(db);
    await repo.create({ userId: u.id, tokenHash: "abc123" });
    const found = await repo.findUserByTokenHash("abc123");
    expect(found?.id).toBe(u.id);
    expect(found?.role).toBe("user");
  });

  it("findUserByTokenHash returns null for an unknown token", async () => {
    const repo = createSessionRepo(await createTestDb());
    expect(await repo.findUserByTokenHash("nope")).toBeNull();
  });

  it("deleteByTokenHash logs the user out (row gone)", async () => {
    const db = await createTestDb();
    const u = await seedUser(db);
    const repo = createSessionRepo(db);
    await repo.create({ userId: u.id, tokenHash: "tok" });
    await repo.deleteByTokenHash("tok");
    expect(await repo.findUserByTokenHash("tok")).toBeNull();
  });

  it("does not bump lastUsedAt when it was touched less than 5 minutes ago", async () => {
    const db = await createTestDb();
    const u = await seedUser(db);
    const repo = createSessionRepo(db);
    await repo.create({ userId: u.id, tokenHash: "fresh" });
    const fresh = new Date(Date.now() - 60_000); // 1 min ago — under the 5 min throttle
    await db.update(sessions).set({ lastUsedAt: fresh }).where(eq(sessions.tokenHash, "fresh"));

    const found = await repo.findUserByTokenHash("fresh");

    expect(found?.id).toBe(u.id);
    expect((await readLastUsedAt(db, "fresh")).getTime()).toBe(fresh.getTime());
  });

  it("bumps lastUsedAt when it is more than 5 minutes stale", async () => {
    const db = await createTestDb();
    const u = await seedUser(db);
    const repo = createSessionRepo(db);
    await repo.create({ userId: u.id, tokenHash: "stale" });
    const stale = new Date(Date.now() - 6 * 60_000); // 6 min ago — over the 5 min throttle
    await db.update(sessions).set({ lastUsedAt: stale }).where(eq(sessions.tokenHash, "stale"));

    const before = Date.now();
    const found = await repo.findUserByTokenHash("stale");

    expect(found?.id).toBe(u.id);
    const after = await readLastUsedAt(db, "stale");
    expect(after.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("deletes and rejects a session idle for more than 30 days", async () => {
    const db = await createTestDb();
    const u = await seedUser(db);
    const repo = createSessionRepo(db);
    await repo.create({ userId: u.id, tokenHash: "old" });
    const idle = new Date(Date.now() - 31 * 24 * 60 * 60_000); // 31 days
    await db.update(sessions).set({ lastUsedAt: idle }).where(eq(sessions.tokenHash, "old"));

    expect(await repo.findUserByTokenHash("old")).toBeNull();
    const [row] = await db.select().from(sessions).where(eq(sessions.tokenHash, "old"));
    expect(row).toBeUndefined(); // row deleted, not just rejected
  });

  it("a session idle 29 days still resolves (sliding window)", async () => {
    const db = await createTestDb();
    const u = await seedUser(db);
    const repo = createSessionRepo(db);
    await repo.create({ userId: u.id, tokenHash: "fresh30" });
    const idle = new Date(Date.now() - 29 * 24 * 60 * 60_000);
    await db.update(sessions).set({ lastUsedAt: idle }).where(eq(sessions.tokenHash, "fresh30"));

    const found = await repo.findUserByTokenHash("fresh30");
    expect(found?.id).toBe(u.id);
  });
});
