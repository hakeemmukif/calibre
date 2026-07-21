import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDb } from "./test-db";
import { seedAdmin, seedSources, sourceSeeds } from "./seed";
import { sources, users } from "./schema";
import { BOOTSTRAP_ADMIN_ID } from "@/server/auth/ids";
import { verifyPassword } from "@/server/auth/password";
import { connectorForSource } from "@/server/search/connectors";

describe("seedSources", () => {
  it("inserts the 42 sources rows against libsql", async () => {
    const db = await createTestDb();
    const inserted = await seedSources(db);
    expect(inserted).toHaveLength(42);

    const rows = await db.select().from(sources);
    expect(rows.map((r) => r.id).sort()).toEqual([
      "ashby-airwallex",
      "ashby-bjak",
      "ashby-deel",
      "ashby-elevenlabs",
      "ashby-perplexity",
      "ashby-plaid",
      "ashby-ramp",
      "ashby-supabase",
      "ashby-xero",
      "ashby-zapier",
      "gh-agoda",
      "gh-anchanto",
      "gh-bybit",
      "gh-coupang",
      "gh-cultureamp",
      "gh-elastic",
      "gh-gitlab",
      "gh-groww",
      "gh-inmobi",
      "gh-moloco",
      "gh-monsterenergyapac",
      "gh-okta",
      "gh-okx",
      "gh-phonepe",
      "gh-postman",
      "gh-razorpay",
      "gh-remote",
      "gh-stripe",
      "gh-workato",
      "gh-xendit",
      "jobstreet",
      "lever-binance",
      "lever-gotogroup",
      "lever-lalamove",
      "lever-meesho",
      "lever-ninjavan",
      "lever-safetyculture",
      "lever-shopback",
      "lever-toptal",
      "lever-xsolla",
      "manual",
      "sr-grab",
    ]);
    expect(sourceSeeds).toHaveLength(42);
  });
});

describe("seedSources — SEA seeds (task-2-brief 2.1, live-verified slugs)", () => {
  it.each([
    ["lever-gotogroup", "lever", "GoToGroup"],
    ["lever-shopback", "lever", "shopback-2"],
    ["ashby-bjak", "ashby", "bjakcareer"],
  ])("%s resolves via connectorForSource with connector %s and slug %s", (id, connector, slug) => {
    const row = sourceSeeds.find((s) => s.id === id);
    expect(row).toBeDefined();
    expect(row?.persona).toBe("local");
    expect(row?.config).toMatchObject({ connector, slug });

    const resolved = connectorForSource(row as never);
    expect(resolved.id).toBe(id);
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
