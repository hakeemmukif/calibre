import { describe, expect, it } from "vitest";
import { createTestDb } from "./test-db";
import { seedSources, sourceSeeds } from "./seed";
import { sources } from "./schema";

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
