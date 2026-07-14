import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { users } from "../schema";
import { createUserRepo } from "./users";
import { EmailTakenError } from "@/server/auth/errors";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";

describe("users schema", () => {
  it("migration creates an insertable users table on an empty PGlite DB", async () => {
    const db = await createTestDb();
    const [row] = await db
      .insert(users)
      .values({ email: "a@b.co", passwordHash: "x", role: "user" })
      .returning();
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.role).toBe("user");
  });
});

describe("usersRepo", () => {
  it("create() normalizes email to lowercase and findByEmail is case-insensitive", async () => {
    const repo = createUserRepo(await createTestDb());
    const u = await repo.create({ email: "Alex@Example.COM", passwordHash: "h", role: "user" });
    expect(u.email).toBe("alex@example.com");
    expect((await repo.findByEmail("alex@EXAMPLE.com"))?.id).toBe(u.id);
  });

  it("create() throws EmailTakenError on duplicate (normalized) email", async () => {
    const repo = createUserRepo(await createTestDb());
    await repo.create({ email: "dup@x.co", passwordHash: "h", role: "user" });
    await expect(repo.create({ email: "DUP@x.co", passwordHash: "h", role: "user" }))
      .rejects.toBeInstanceOf(EmailTakenError);
  });

  it("users_email_unique constraint fires a 23505 on a direct duplicate insert (foundation for the race-safety catch in create())", async () => {
    const db = await createTestDb();
    await db.insert(users).values({ email: "race@x.co", passwordHash: "h", role: "user" });
    await expect(
      db.insert(users).values({ email: "race@x.co", passwordHash: "h", role: "user" }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("findById returns the row; list() returns all (including the migration-seeded admin)", async () => {
    const repo = createUserRepo(await createTestDb());
    const a = await repo.create({ email: "a@x.co", passwordHash: "h", role: "admin" });
    const b = await repo.create({ email: "b@x.co", passwordHash: "h", role: "user" });
    expect((await repo.findById(a.id))?.role).toBe("admin");
    const list = await repo.list();
    expect(list.length).toBe(3);
    expect(list.map((u) => u.id).sort()).toEqual([BOOTSTRAP_ADMIN_ID, a.id, b.id].sort());
  });
});
