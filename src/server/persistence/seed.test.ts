import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDb } from "./test-db";
import { seedAdmin, seedSources, sourceSeeds } from "./seed";
import { sources, users } from "./schema";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";
import { verifyPassword } from "@/server/auth/password";

describe("seedSources", () => {
  it("inserts the 13 sources rows against PGlite", async () => {
    const db = await createTestDb();
    const inserted = await seedSources(db);
    expect(inserted).toHaveLength(14);

    const rows = await db.select().from(sources);
    expect(rows.map((r) => r.id).sort()).toEqual([
      "ashby-airwallex",
      "ashby-deel",
      "ashby-elevenlabs",
      "ashby-perplexity",
      "ashby-plaid",
      "ashby-ramp",
      "ashby-supabase",
      "ashby-zapier",
      "gh-gitlab",
      "gh-remote",
      "gh-stripe",
      "jobstreet",
      "lever-toptal",
      "manual",
    ]);
    expect(sourceSeeds).toHaveLength(14);
  });
});

describe("seedAdmin", () => {
  it("seedAdmin upserts the fixed-UUID admin from env creds", async () => {
    const db = await createTestDb();
    await seedAdmin(db, { email: "admin@x.co", password: "adminpass1" });
    const [row] = await db.select().from(users).where(eq(users.id, BOOTSTRAP_ADMIN_ID));
    expect(row.role).toBe("admin");
    expect(row.email).toBe("admin@x.co");
    expect(await verifyPassword(row.passwordHash, "adminpass1")).toBe(true);
  });

  it("seedAdmin is idempotent (re-run updates creds, no duplicate)", async () => {
    const db = await createTestDb();
    await seedAdmin(db, { email: "admin@x.co", password: "one12345" });
    await seedAdmin(db, { email: "admin@x.co", password: "two12345" });
    const rows = await db.select().from(users);
    expect(rows.length).toBe(1);
    expect(await verifyPassword(rows[0].passwordHash, "two12345")).toBe(true);
  });
});
