import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db";
import { users } from "../schema";

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
