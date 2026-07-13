import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { users } from "../schema";
import { createSessionRepo } from "./sessions";

async function seedUser(db: Awaited<ReturnType<typeof createTestDb>>) {
  const [u] = await db.insert(users).values({ email: "s@x.co", passwordHash: "h", role: "user" }).returning();
  return u;
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
});
