import { describe, expect, it } from "vitest";
import { createTestDb } from "./test-db";
import { seedSources, sourceSeeds } from "./seed";
import { sources } from "./schema";

describe("seedSources", () => {
  it("inserts the 4 sources rows against PGlite", async () => {
    const db = await createTestDb();
    const inserted = await seedSources(db);
    expect(inserted).toHaveLength(4);

    const rows = await db.select().from(sources);
    expect(rows.map((r) => r.id).sort()).toEqual(["ashby", "greenhouse", "jobstreet", "lever"]);
    expect(sourceSeeds).toHaveLength(4);
  });
});
